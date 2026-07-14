// SPDX-License-Identifier: Apache-2.0
//! Sentinel — programmable compliance for Token-2022 tokenized assets, built on
//! the Transfer Hook extension.
//!
//! Each mint has a `PolicyConfig` that toggles the active rules. On every
//! transfer the hook enforces them:
//!   - **limit**: `amount <= max_transfer_amount` (when `max_transfer_amount > 0`)
//!   - **allowlist** (when enabled): the recipient must have an `AllowEntry`
//!   - **blocklist** (when enabled): neither sender nor recipient may have a `BlockEntry`
use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::token_interface::Mint;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("4Lr94hphpGHq2VY6CRC5Yxq6k3gs9nSSzsh479hVU1Xw");

const META_LIST_SEED: &[u8] = b"extra-account-metas";
const POLICY_SEED: &[u8] = b"policy";
const ALLOW_SEED: &[u8] = b"allow";
const BLOCK_SEED: &[u8] = b"block";
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
    ) -> Result<()> {
        ctx.accounts.policy_config.set_inner(PolicyConfig {
            mint: ctx.accounts.mint.key(),
            authority: ctx.accounts.authority.key(),
            allowlist_enabled,
            blocklist_enabled,
            max_transfer_amount,
            bump: ctx.bumps.policy_config,
        });
        Ok(())
    }

    /// Update the mint's policy. Only the policy authority may call this.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        allowlist_enabled: bool,
        blocklist_enabled: bool,
        max_transfer_amount: u64,
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy_config;
        policy.allowlist_enabled = allowlist_enabled;
        policy.blocklist_enabled = blocklist_enabled;
        policy.max_transfer_amount = max_transfer_amount;
        Ok(())
    }

    /// Create and initialize the `ExtraAccountMetaList` PDA for `mint`, declaring
    /// the accounts the hook needs on every transfer: the policy config, the
    /// sender's and recipient's blocklist entries, and the recipient's allowlist
    /// entry (all resolved from the transfer's own accounts).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let extra_account_metas = vec![
            // index 5: policy config ["policy", mint]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: POLICY_SEED.to_vec() },
                    Seed::AccountKey { index: 1 },
                ],
                false,
                false,
            )?,
            // index 6: sender block entry ["block", mint, source_owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: BLOCK_SEED.to_vec() },
                    Seed::AccountKey { index: 1 },
                    Seed::AccountData {
                        account_index: 0, // source token account
                        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                        length: 32,
                    },
                ],
                false,
                false,
            )?,
            // index 7: recipient block entry ["block", mint, dest_owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: BLOCK_SEED.to_vec() },
                    Seed::AccountKey { index: 1 },
                    Seed::AccountData {
                        account_index: 2, // destination token account
                        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                        length: 32,
                    },
                ],
                false,
                false,
            )?,
            // index 8: recipient allow entry ["allow", mint, dest_owner]
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal { bytes: ALLOW_SEED.to_vec() },
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
        ];

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
        Ok(())
    }

    /// Add a wallet to a mint's allowlist by creating its `AllowEntry` PDA.
    pub fn add_to_allowlist(ctx: Context<AddToAllowlist>) -> Result<()> {
        ctx.accounts.allow_entry.set_inner(AllowEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.allow_entry,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's allowlist by closing its `AllowEntry` PDA.
    pub fn remove_from_allowlist(_ctx: Context<RemoveFromAllowlist>) -> Result<()> {
        Ok(())
    }

    /// Add a wallet to a mint's blocklist by creating its `BlockEntry` PDA.
    pub fn add_to_blocklist(ctx: Context<AddToBlocklist>) -> Result<()> {
        ctx.accounts.block_entry.set_inner(BlockEntry {
            mint: ctx.accounts.mint.key(),
            wallet: ctx.accounts.wallet.key(),
            bump: ctx.bumps.block_entry,
        });
        Ok(())
    }

    /// Remove a wallet from a mint's blocklist by closing its `BlockEntry` PDA.
    pub fn remove_from_blocklist(_ctx: Context<RemoveFromBlocklist>) -> Result<()> {
        Ok(())
    }

    /// Invoked by Token-2022 on every transfer. Enforces the mint's policy.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        let policy = &ctx.accounts.policy_config;

        // Limit rule.
        if policy.max_transfer_amount > 0 {
            require!(
                amount <= policy.max_transfer_amount,
                SentinelError::TransferExceedsLimit
            );
        }

        // Blocklist rule (neither party may be blocked).
        if policy.blocklist_enabled {
            require!(!is_active(&ctx.accounts.source_block, ctx.program_id), SentinelError::SenderBlocked);
            require!(!is_active(&ctx.accounts.dest_block, ctx.program_id), SentinelError::RecipientBlocked);
        }

        // Allowlist rule (recipient must be allowlisted).
        if policy.allowlist_enabled {
            require!(is_active(&ctx.accounts.allow_entry, ctx.program_id), SentinelError::RecipientNotAllowlisted);
        }

        msg!("Sentinel: transfer allowed ({} units)", amount);
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

/// Per-mint compliance policy: which rules are active and their parameters.
#[account]
pub struct PolicyConfig {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub max_transfer_amount: u64,
    pub bump: u8,
}

impl PolicyConfig {
    const LEN: usize = 8 + 32 + 32 + 1 + 1 + 8 + 1;
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

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

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

    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddToAllowlist<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

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

/// Accounts for the Transfer Hook `Execute`. Order is fixed by the interface:
/// source, mint, destination, source authority, meta-list PDA, then our declared
/// extra accounts (policy, sender block, recipient block, recipient allow).
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
}
