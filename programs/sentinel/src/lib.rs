// SPDX-License-Identifier: Apache-2.0
//! Sentinel — programmable compliance for Token-2022 tokenized assets, built on
//! the Transfer Hook extension.
//!
//! Each mint has a `PolicyConfig` that toggles the active rules. On every
//! transfer the hook enforces them:
//!   - **limit**: `amount <= max_transfer_amount` (when `max_transfer_amount > 0`)
//!   - **allowlist** (when enabled): the recipient must have an `AllowEntry`
//!   - **blocklist** (when enabled): neither sender nor recipient may have a `BlockEntry`
//!
//! The blocklist also covers the transfer authority, so a blocked wallet cannot move tokens as a
//! delegate of someone else's account (2.1; mints created before 2.1 call
//! `update_extra_account_meta_list` once to get this).
//!
//! Confidential transfers are a special case. Token-2022 hides the amount from
//! the hook, so the limit rule cannot be evaluated at all — it is unenforceable
//! rather than satisfied. A mint that sets a limit therefore refuses
//! confidential transfers unless its policy sets `allow_confidential`, which is
//! the issuer explicitly accepting that the limit does not apply to them. The
//! allowlist and blocklist rules work on addresses, so they apply to
//! confidential transfers unchanged.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::system_program::{create_account, transfer, CreateAccount, Transfer};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

/// Token-2022 invokes the transfer hook for a **confidential** transfer with
/// `amount` set to `u64::MAX`, because the real amount is encrypted and the
/// program cannot see it. Treat this value as "amount unknown", never as a
/// literal quantity.
pub const CONFIDENTIAL_TRANSFER_AMOUNT: u64 = u64::MAX;

declare_id!("5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD");

const META_LIST_SEED: &[u8] = b"extra-account-metas";
const POLICY_SEED: &[u8] = b"policy";
const ALLOW_SEED: &[u8] = b"allow";
const BLOCK_SEED: &[u8] = b"block";
const PENDING_AUTHORITY_SEED: &[u8] = b"pending-authority";
/// Offset of the `owner` field in an SPL token account (mint[0..32], owner[32..64]).
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

#[program]
pub mod sentinel {
    use super::*;

    /// Create the mint's `PolicyConfig`. The signer becomes its authority.
    pub fn initialize_policy(
        ctx: Context<InitializePolicy>,
        allowlist_enabled: bool,
        blocklist_enabled: bool,
        max_transfer_amount: u64,
        allow_confidential: bool,
    ) -> Result<()> {
        ctx.accounts.policy_config.set_inner(PolicyConfig {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
            bump: ctx.bumps.policy_config,
        });
        emit!(PolicyInitialized {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
        });
        Ok(())
    }

    /// Update the mint's policy. Only the policy authority may call this.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        allowlist_enabled: bool,
        blocklist_enabled: bool,
        max_transfer_amount: u64,
        allow_confidential: bool,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy_config;
        policy.allowlist_enabled = allowlist_enabled;
        policy.blocklist_enabled = blocklist_enabled;
        policy.max_transfer_amount = max_transfer_amount;
        policy.allow_confidential = allow_confidential;
        emit!(PolicyUpdated {
            mint: policy.mint,
            authority: policy.authority,
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            allow_confidential,
        });
        Ok(())
    }

    /// Create and initialize the `ExtraAccountMetaList` PDA for `mint`, declaring
    /// the accounts the hook needs on every transfer: the policy config, the
    /// sender's and recipient's blocklist entries, and the recipient's allowlist
    /// entry (all resolved from the transfer's own accounts).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let extra_account_metas = extra_account_metas()?;

        let account_size = ExtraAccountMetaList::size_of(extra_account_metas.len())? as u64;
        let lamports = Rent::get()?.minimum_balance(account_size as usize);

        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.bumps.extra_account_meta_list;
        let signer_seeds: &[&[&[u8]]] = &[&[META_LIST_SEED, mint_key.as_ref(), &[bump]]];

        create_account(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
            )
            .with_signer(signer_seeds),
            lamports,
            account_size,
            ctx.program_id,
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;

        msg!("Sentinel: meta list initialized for mint {}", mint_key);
        emit!(MetaListUpdated {
            mint: mint_key,
            entries: extra_account_metas.len() as u8,
        });
        Ok(())
    }

    /// Rewrite a mint's `ExtraAccountMetaList` to the current list, growing the account if
    /// needed. Mints initialized before 2.1 run this once so the hook also receives the transfer
    /// authority's blocklist entry. The list's content is fixed by the program; only the policy
    /// authority may trigger the rewrite, and it pays for any extra rent.
    pub fn update_extra_account_meta_list(ctx: Context<UpdateExtraAccountMetaList>) -> Result<()> {
        let extra_account_metas = extra_account_metas()?;
        let new_len = ExtraAccountMetaList::size_of(extra_account_metas.len())?;
        let meta_list = ctx.accounts.extra_account_meta_list.to_account_info();

        if meta_list.data_len() < new_len {
            let required = Rent::get()?.minimum_balance(new_len);
            let top_up = required.saturating_sub(meta_list.lamports());
            if top_up > 0 {
                transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: meta_list.clone(),
                        },
                    ),
                    top_up,
                )?;
            }
            meta_list.resize(new_len)?;
        }

        ExtraAccountMetaList::update::<ExecuteInstruction>(
            &mut meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )?;

        emit!(MetaListUpdated {
            mint: ctx.accounts.mint.key(),
            entries: extra_account_metas.len() as u8,
        });
        Ok(())
    }

    /// Add a wallet to a mint's allowlist by creating its `AllowEntry` PDA.
    pub fn add_to_allowlist(ctx: Context<AddToAllowlist>) -> Result<()> {
        ctx.accounts.allow_entry.set_inner(AllowEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.allow_entry,
        });
        emit!(ListEntryAdded {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Allow,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's allowlist by closing its `AllowEntry` PDA.
    pub fn remove_from_allowlist(ctx: Context<RemoveFromAllowlist>) -> Result<()> {
        emit!(ListEntryRemoved {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Allow,
        });
        Ok(())
    }

    /// Add a wallet to a mint's blocklist by creating its `BlockEntry` PDA.
    pub fn add_to_blocklist(ctx: Context<AddToBlocklist>) -> Result<()> {
        ctx.accounts.block_entry.set_inner(BlockEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.block_entry,
        });
        emit!(ListEntryAdded {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Block,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's blocklist by closing its `BlockEntry` PDA.
    pub fn remove_from_blocklist(ctx: Context<RemoveFromBlocklist>) -> Result<()> {
        emit!(ListEntryRemoved {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            list: ListKind::Block,
        });
        Ok(())
    }

    /// Start handing the policy to `new_authority` (for example a multisig vault). Nothing
    /// changes until `new_authority` accepts, so a mistyped address cannot lock the policy.
    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        let current = ctx.accounts.authority.key();
        require!(
            new_authority != Pubkey::default() && new_authority != current,
            SentinelError::InvalidAuthority
        );
        ctx.accounts.pending_authority.set_inner(PendingAuthority {
            mint: ctx.accounts.mint.key(),
            new_authority,
            bump: ctx.bumps.pending_authority,
        });
        emit!(AuthorityTransferProposed {
            mint: ctx.accounts.mint.key(),
            authority: current,
            new_authority,
        });
        Ok(())
    }

    /// Withdraw a pending proposal. Only the current authority may call this.
    pub fn cancel_authority_transfer(ctx: Context<CancelAuthorityTransfer>) -> Result<()> {
        emit!(AuthorityTransferCancelled {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            new_authority: ctx.accounts.pending_authority.new_authority,
        });
        Ok(())
    }

    /// Complete the handover: the proposed authority signs and becomes the policy authority.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let policy = &mut ctx.accounts.policy_config;
        let previous = policy.authority;
        policy.authority = ctx.accounts.new_authority.key();
        emit!(AuthorityTransferred {
            mint: policy.mint,
            previous_authority: previous,
            new_authority: policy.authority,
        });
        Ok(())
    }

    /// Invoked by Token-2022 on every transfer. Enforces the mint's policy.
    ///
    /// A refusal emits `TransferRefused` before returning the error, so indexers can read the
    /// reason from the failed transaction's logs.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let is_confidential = amount == CONFIDENTIAL_TRANSFER_AMOUNT;
        if let Err(reason) = check_transfer(&ctx, amount, is_confidential) {
            emit!(TransferRefused {
                mint: ctx.accounts.mint.key(),
                source_owner: token_account_owner(&ctx.accounts.source_token),
                destination_owner: token_account_owner(&ctx.accounts.destination_token),
                transfer_authority: ctx.accounts.owner.key(),
                confidential: is_confidential,
                error_code: u32::from(reason),
            });
            return Err(reason.into());
        }

        if is_confidential {
            msg!("Sentinel: confidential transfer allowed (amount not visible to the hook)");
        } else {
            msg!("Sentinel: transfer allowed ({} units)", amount);
        }
        Ok(())
    }

    /// Route Token-2022's `Execute` (transfer-hook interface discriminator) to
    /// `transfer_hook`.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}

/// An entry account (allow or block) is "active" when it exists: owned by this
/// program with non-empty data. A non-existent PDA is owned by the system program.
fn is_active(account: &AccountInfo, program_id: &Pubkey) -> bool {
    account.owner == program_id && !account.data_is_empty()
}

/// The accounts the hook needs on every transfer, in the order the `TransferHook` accounts and
/// `remaining_accounts` expect them. Index 0-4 are fixed by the transfer-hook interface: source,
/// mint, destination, transfer authority, this list.
fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let block_entry_of_owner = |account_index: u8| -> Result<ExtraAccountMeta> {
        Ok(ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: BLOCK_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?)
    };
    Ok(vec![
        // index 5: policy config ["policy", mint]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // index 6: sender block entry ["block", mint, source_owner]
        block_entry_of_owner(0)?,
        // index 7: recipient block entry ["block", mint, dest_owner]
        block_entry_of_owner(2)?,
        // index 8: recipient allow entry ["allow", mint, dest_owner]
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: ALLOW_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountData {
                    account_index: 2,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // index 9 (2.1): transfer authority block entry ["block", mint, authority]. Same as
        // index 6 when the owner signs; differs when a delegate moves the tokens.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: BLOCK_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                Seed::AccountKey { index: 3 },
            ],
            false,
            false,
        )?,
    ])
}

/// Evaluate the mint's policy for one transfer. `Err` carries the rule that refused it.
fn check_transfer(
    ctx: &Context<TransferHook>,
    amount: u64,
    is_confidential: bool,
) -> core::result::Result<(), SentinelError> {
    let policy = &ctx.accounts.policy_config;

    // Limit rule. A confidential transfer hides its amount from the hook, so the limit cannot be
    // checked. Refuse rather than wave it through, unless the policy has opted in to going
    // without the limit.
    if policy.max_transfer_amount > 0 {
        if is_confidential {
            if !policy.allow_confidential {
                return Err(SentinelError::ConfidentialAmountNotEnforceable);
            }
        } else if amount > policy.max_transfer_amount {
            return Err(SentinelError::TransferExceedsLimit);
        }
    }

    // Blocklist rule: neither party may be blocked, nor the authority moving the tokens.
    if policy.blocklist_enabled {
        if is_active(&ctx.accounts.source_block, ctx.program_id) {
            return Err(SentinelError::SenderBlocked);
        }
        if is_active(&ctx.accounts.dest_block, ctx.program_id) {
            return Err(SentinelError::RecipientBlocked);
        }
        // Present only once the mint's meta list carries index 9 (2.1). It arrives through
        // `remaining_accounts`, so its content is checked rather than trusted: it blocks only
        // if it is this program's `BlockEntry` for this mint and this authority.
        if let Some(entry) = ctx.remaining_accounts.first() {
            if is_block_entry_for(entry, &ctx.accounts.mint.key(), &ctx.accounts.owner.key()) {
                return Err(SentinelError::AuthorityBlocked);
            }
        }
    }

    // Allowlist rule (recipient must be allowlisted).
    if policy.allowlist_enabled && !is_active(&ctx.accounts.allow_entry, ctx.program_id) {
        return Err(SentinelError::RecipientNotAllowlisted);
    }
    Ok(())
}

/// Whether `account` is this program's `BlockEntry` for (`mint`, `wallet`).
fn is_block_entry_for(account: &AccountInfo, mint: &Pubkey, wallet: &Pubkey) -> bool {
    if account.owner != &crate::ID {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    let mut bytes: &[u8] = &data;
    match BlockEntry::try_deserialize(&mut bytes) {
        Ok(entry) => entry.mint == *mint && entry.wallet == *wallet,
        Err(_) => false,
    }
}

/// The `owner` field of an SPL token account, or the default address if the data is too short.
fn token_account_owner(account: &AccountInfo) -> Pubkey {
    let start = TOKEN_ACCOUNT_OWNER_OFFSET as usize;
    account
        .try_borrow_data()
        .ok()
        .and_then(|data| data.get(start..start + 32).map(Pubkey::try_from))
        .and_then(|owner| owner.ok())
        .unwrap_or_default()
}

/// Per-mint compliance policy: which rules are active and their parameters.
#[account]
pub struct PolicyConfig {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    /// Permit confidential transfers on a mint that also sets
    /// `max_transfer_amount`. The limit cannot be enforced on an encrypted
    /// amount, so the issuer opts in to that gap explicitly. Irrelevant when no
    /// limit is set, because there is then nothing to enforce.
    pub allow_confidential: bool,
    pub bump: u8,
}

impl PolicyConfig {
    const LEN: usize = 8 + 32 + 32 + 1 + 1 + 8 + 1 + 1;
}

/// An allowlist entry: its existence means `wallet` may receive `mint`.
#[account]
pub struct AllowEntry {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub bump: u8,
}

/// A blocklist entry: its existence means `wallet` may neither send nor receive `mint`.
#[account]
pub struct BlockEntry {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub bump: u8,
}

/// Shared on-chain size for the simple (mint, wallet, bump) entry accounts.
const ENTRY_LEN: usize = 8 + 32 + 32 + 1;

/// A proposed handover of a mint's policy authority, waiting for `new_authority` to accept.
#[account]
pub struct PendingAuthority {
    pub mint: Pubkey,
    pub new_authority: Pubkey,
    pub bump: u8,
}

impl PendingAuthority {
    const LEN: usize = 8 + 32 + 32 + 1;
}

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        constraint = mint.mint_authority == COption::Some(authority.key()) @ SentinelError::Unauthorized,
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = PolicyConfig::LEN,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy is governed (address only, used for the seed).
    pub mint: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: PDA that stores the extra-account-meta list; created & written here.
    #[account(
        mut,
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    #[account(
        constraint = mint.mint_authority == COption::Some(payer.key()) @ SentinelError::Unauthorized,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToAllowlist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being allowlisted (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = ENTRY_LEN,
        seeds = [ALLOW_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromAllowlist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being removed (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [ALLOW_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump = allow_entry.bump
    )]
    pub allow_entry: Account<'info, AllowEntry>,
}

#[derive(Accounts)]
pub struct AddToBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being blocklisted (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = ENTRY_LEN,
        seeds = [BLOCK_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub block_entry: Account<'info, BlockEntry>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveFromBlocklist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: the wallet being removed (address only).
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [BLOCK_SEED, mint.key().as_ref(), wallet.key().as_ref()],
        bump = block_entry.bump
    )]
    pub block_entry: Account<'info, BlockEntry>,
}

#[derive(Accounts)]
pub struct UpdateExtraAccountMetaList<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose list is rewritten (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    /// CHECK: this program's ExtraAccountMetaList PDA for `mint`; resized and rewritten here.
    #[account(
        mut,
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump,
        owner = crate::ID,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy is handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        init,
        payer = authority,
        space = PendingAuthority::LEN,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump
    )]
    pub pending_authority: Account<'info, PendingAuthority>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelAuthorityTransfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the mint whose policy was being handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
        has_one = authority @ SentinelError::Unauthorized,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump = pending_authority.bump,
    )]
    pub pending_authority: Account<'info, PendingAuthority>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,

    /// CHECK: the outgoing authority, which paid for the proposal and gets its rent back.
    #[account(mut, address = policy_config.authority @ SentinelError::Unauthorized)]
    pub previous_authority: AccountInfo<'info>,

    /// CHECK: the mint whose policy is handed over (address only, used for the seeds).
    pub mint: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump,
    )]
    pub policy_config: Account<'info, PolicyConfig>,

    #[account(
        mut,
        close = previous_authority,
        seeds = [PENDING_AUTHORITY_SEED, mint.key().as_ref()],
        bump = pending_authority.bump,
        constraint = pending_authority.new_authority == new_authority.key() @ SentinelError::Unauthorized,
    )]
    pub pending_authority: Account<'info, PendingAuthority>,
}

/// Accounts for the Transfer Hook `Execute`. Order is fixed by the interface:
/// source, mint, destination, source authority, meta-list PDA, then our declared
/// extra accounts (policy, sender block, recipient block, recipient allow).
///
/// From 2.1 the list has a fifth extra account, the transfer authority's blocklist entry. It is
/// read from `remaining_accounts`, so mints whose list predates 2.1 keep working without it.
///
/// The entry accounts are bare `AccountInfo`: Token-2022 resolves them
/// deterministically from the ExtraAccountMetaList (by mint + the token accounts'
/// owner fields), and the hook only runs via Token-2022's CPI — so a caller
/// cannot substitute a different allow/block entry.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: source token account
    pub source_token: AccountInfo<'info>,
    /// CHECK: mint
    pub mint: AccountInfo<'info>,
    /// CHECK: destination token account
    pub destination_token: AccountInfo<'info>,
    /// CHECK: source authority (owner or delegate)
    pub owner: AccountInfo<'info>,
    /// CHECK: ExtraAccountMetaList PDA for this mint
    #[account(seeds = [META_LIST_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: AccountInfo<'info>,
    #[account(
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump = policy_config.bump
    )]
    pub policy_config: Account<'info, PolicyConfig>,
    /// CHECK: sender's blocklist entry PDA; may be uninitialized (= not blocked)
    pub source_block: AccountInfo<'info>,
    /// CHECK: recipient's blocklist entry PDA; may be uninitialized (= not blocked)
    pub dest_block: AccountInfo<'info>,
    /// CHECK: recipient's allowlist entry PDA; may be uninitialized (= not allowlisted)
    pub allow_entry: AccountInfo<'info>,
}

#[error_code]
pub enum SentinelError {
    #[msg("Recipient is not on the allowlist for this mint")]
    RecipientNotAllowlisted,
    #[msg("Transfer amount exceeds the policy limit")]
    TransferExceedsLimit,
    #[msg("Sender is blocklisted for this mint")]
    SenderBlocked,
    #[msg("Recipient is blocklisted for this mint")]
    RecipientBlocked,
    #[msg("Only the policy authority may perform this action")]
    Unauthorized,
    // Appended, so the existing variants keep their error codes.
    #[msg("This mint sets a transfer limit, which cannot be enforced on a confidential transfer; set allow_confidential on the policy to permit them")]
    ConfidentialAmountNotEnforceable,
    #[msg(
        "The transfer authority (a delegate of the source account) is blocklisted for this mint"
    )]
    AuthorityBlocked,
    #[msg("The new authority must be a real address and differ from the current one")]
    InvalidAuthority,
}

/// Which list an entry belongs to.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ListKind {
    Allow,
    Block,
}

#[event]
pub struct PolicyInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

#[event]
pub struct PolicyUpdated {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

#[event]
pub struct ListEntryAdded {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub list: ListKind,
}

#[event]
pub struct ListEntryRemoved {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub list: ListKind,
}

#[event]
pub struct MetaListUpdated {
    pub mint: Pubkey,
    pub entries: u8,
}

#[event]
pub struct AuthorityTransferProposed {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferCancelled {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct AuthorityTransferred {
    pub mint: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}

/// Emitted by the hook just before it refuses a transfer. The transaction fails, but its logs
/// (and this event) stay readable. `error_code` is the `SentinelError` code, e.g. 6003.
#[event]
pub struct TransferRefused {
    pub mint: Pubkey,
    pub source_owner: Pubkey,
    pub destination_owner: Pubkey,
    pub transfer_authority: Pubkey,
    pub confidential: bool,
    pub error_code: u32,
}
