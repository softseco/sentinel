// SPDX-License-Identifier: Apache-2.0
//! A Sentinel mint in LiteSVM: the built program, Token-2022 v11.1 from `tests/fixtures`, and
//! plain builders for every Sentinel instruction (Anchor discriminators and Borsh arguments, written
//! out by hand so this crate does not depend on the program crate).
// `send` returns LiteSVM's own error type, large but only ever built in tests.
#![allow(dead_code, clippy::result_large_err)]

use litesvm::{types::FailedTransactionMetadata, LiteSVM};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_address::Address as Pubkey;
use solana_instruction::{AccountMeta, Instruction};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use spl_token_2022_interface::{
    extension::{transfer_hook, ExtensionType},
    state::{Account as TokenAccount, Mint},
};

pub const SENTINEL_ID: Pubkey =
    Pubkey::from_str_const("5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD");
pub const TOKEN_2022_ID: Pubkey =
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SYSTEM_ID: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");

/// Sentinel's error codes (`SentinelError` in the program, 6000 + position).
pub mod code {
    pub const RECIPIENT_NOT_ALLOWLISTED: u32 = 6000;
    pub const TRANSFER_EXCEEDS_LIMIT: u32 = 6001;
    pub const SENDER_BLOCKED: u32 = 6002;
    pub const RECIPIENT_BLOCKED: u32 = 6003;
    pub const UNAUTHORIZED: u32 = 6004;
    pub const CONFIDENTIAL_AMOUNT_NOT_ENFORCEABLE: u32 = 6005;
    pub const AUTHORITY_BLOCKED: u32 = 6006;
    pub const INVALID_AUTHORITY: u32 = 6007;
    pub const FREEZE_AUTHORITY_NOT_SENTINEL: u32 = 6008;
}

/// Token-2022's error codes that the model predicts (`TokenError`, by position).
pub mod token_code {
    pub const INVALID_STATE: u32 = 13;
    pub const ACCOUNT_FROZEN: u32 = 17;
}

/// Path of a file next to this crate, overridable by an environment variable.
fn path(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/{}", env!("CARGO_MANIFEST_DIR"), default))
}

/// A LiteSVM with Token-2022 v11.1 (the same build the integration tests use) and Sentinel.
pub fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    let token = path("TOKEN_2022_SO", "../tests/fixtures/spl_token_2022.so");
    let sentinel = path("SENTINEL_SO", "../target/deploy/sentinel.so");
    svm.add_program_from_file(TOKEN_2022_ID, &token)
        .unwrap_or_else(|e| panic!("loading {token}: {e:?}"));
    svm.add_program_from_file(SENTINEL_ID, &sentinel)
        .unwrap_or_else(|e| panic!("loading {sentinel}: {e:?} (run `anchor build` first)"));
    svm
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &SENTINEL_ID).0
}
pub fn policy_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"policy", mint.as_ref()])
}
pub fn meta_list_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"extra-account-metas", mint.as_ref()])
}
pub fn pending_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"pending-authority", mint.as_ref()])
}
pub fn allow_pda(mint: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"allow", mint.as_ref(), wallet.as_ref()])
}
pub fn block_pda(mint: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"block", mint.as_ref(), wallet.as_ref()])
}
pub fn freeze_authority_pda(mint: &Pubkey) -> Pubkey {
    pda(&[b"freeze-authority", mint.as_ref()])
}

/// The first 8 bytes of sha256(`preimage`).
fn discriminator(preimage: &str) -> [u8; 8] {
    let hash = Sha256::digest(preimage.as_bytes());
    hash[..8].try_into().unwrap()
}

fn anchor_ix(name: &str, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = discriminator(&format!("global:{name}")).to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: SENTINEL_ID,
        accounts,
        data,
    }
}

fn w(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, false)
}
fn ws(key: Pubkey) -> AccountMeta {
    AccountMeta::new(key, true)
}
fn r(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
fn rs(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}

/// The policy's flags and limit, as `initialize_policy` and `update_policy` take them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub allowlist: bool,
    pub blocklist: bool,
    pub max_transfer_amount: u64,
    pub allow_confidential: bool,
}

impl Rules {
    fn args(&self) -> Vec<u8> {
        let mut v = vec![self.allowlist as u8, self.blocklist as u8];
        v.extend_from_slice(&self.max_transfer_amount.to_le_bytes());
        v.push(self.allow_confidential as u8);
        v
    }
}

/// The issuer's reason for an enforcement action: `reason_code` and `case_ref`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reason {
    pub code: u16,
    pub case_ref: [u8; 32],
}

impl Reason {
    fn args(&self) -> Vec<u8> {
        let mut v = self.code.to_le_bytes().to_vec();
        v.extend_from_slice(&self.case_ref);
        v
    }
}

/// `EnforcementKind` in the program, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Block,
    Unblock,
    Freeze,
    Thaw,
}

/// A decoded `FreezeAuthorityChanged` event (2.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FreezeChange {
    pub mint: Pubkey,
    pub new_freeze_authority: Option<Pubkey>,
    pub reason: Reason,
    pub authority: Pubkey,
}

/// A decoded `EnforcementAction` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Enforcement {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub token_account: Pubkey,
    pub action: Action,
    pub reason: Reason,
    pub authority: Pubkey,
}

pub mod ix {
    use super::*;

    pub fn initialize_policy(authority: Pubkey, mint: Pubkey, rules: Rules) -> Instruction {
        anchor_ix(
            "initialize_policy",
            &rules.args(),
            vec![ws(authority), r(mint), w(policy_pda(&mint)), r(SYSTEM_ID)],
        )
    }
    pub fn update_policy(authority: Pubkey, mint: Pubkey, rules: Rules) -> Instruction {
        anchor_ix(
            "update_policy",
            &rules.args(),
            vec![rs(authority), r(mint), w(policy_pda(&mint))],
        )
    }
    pub fn initialize_meta_list(payer: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "initialize_extra_account_meta_list",
            &[],
            vec![ws(payer), w(meta_list_pda(&mint)), r(mint), r(SYSTEM_ID)],
        )
    }
    pub fn update_meta_list(authority: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "update_extra_account_meta_list",
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(meta_list_pda(&mint)),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn add_to_list(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
    ) -> Instruction {
        let (name, entry) = if block {
            ("add_to_blocklist", block_pda(&mint, &wallet))
        } else {
            ("add_to_allowlist", allow_pda(&mint, &wallet))
        };
        anchor_ix(
            name,
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(wallet),
                w(entry),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn remove_from_list(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
    ) -> Instruction {
        let (name, entry) = if block {
            ("remove_from_blocklist", block_pda(&mint, &wallet))
        } else {
            ("remove_from_allowlist", allow_pda(&mint, &wallet))
        };
        anchor_ix(
            name,
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                r(wallet),
                w(entry),
            ],
        )
    }
    /// `block_wallet` / `unblock_wallet`: the list instructions with a recorded reason.
    pub fn block_with_reason(
        block: bool,
        authority: Pubkey,
        mint: Pubkey,
        wallet: Pubkey,
        reason: Reason,
    ) -> Instruction {
        let mut ix = if block {
            add_to_list(true, authority, mint, wallet)
        } else {
            remove_from_list(true, authority, mint, wallet)
        };
        let name = if block {
            "block_wallet"
        } else {
            "unblock_wallet"
        };
        ix.data = discriminator(&format!("global:{name}")).to_vec();
        ix.data.extend_from_slice(&reason.args());
        ix
    }

    /// `freeze_token_account` (`freeze`) or `thaw_token_account`.
    pub fn set_frozen(
        freeze: bool,
        authority: Pubkey,
        mint: Pubkey,
        token_account: Pubkey,
        reason: Reason,
    ) -> Instruction {
        let name = if freeze {
            "freeze_token_account"
        } else {
            "thaw_token_account"
        };
        anchor_ix(
            name,
            &reason.args(),
            vec![
                rs(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(token_account),
                r(freeze_authority_pda(&mint)),
                r(TOKEN_2022_ID),
            ],
        )
    }

    /// Sentinel's `set_freeze_authority` (2.3): hand the mint's freeze authority from Sentinel's
    /// address to `new`, or give it up with `None`.
    pub fn set_freeze_authority(
        authority: Pubkey,
        mint: Pubkey,
        new: Option<Pubkey>,
        reason: Reason,
    ) -> Instruction {
        let mut args = match new {
            Some(key) => {
                let mut v = vec![1u8];
                v.extend_from_slice(key.as_ref());
                v
            }
            None => vec![0u8],
        };
        args.extend_from_slice(&reason.args());
        anchor_ix(
            "set_freeze_authority",
            &args,
            vec![
                rs(authority),
                w(mint),
                r(policy_pda(&mint)),
                r(freeze_authority_pda(&mint)),
                r(TOKEN_2022_ID),
            ],
        )
    }

    pub fn propose_authority(
        authority: Pubkey,
        mint: Pubkey,
        new_authority: Pubkey,
    ) -> Instruction {
        anchor_ix(
            "propose_authority",
            new_authority.as_ref(),
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(pending_pda(&mint)),
                r(SYSTEM_ID),
            ],
        )
    }
    pub fn cancel_authority_transfer(authority: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "cancel_authority_transfer",
            &[],
            vec![
                ws(authority),
                r(mint),
                r(policy_pda(&mint)),
                w(pending_pda(&mint)),
            ],
        )
    }
    pub fn accept_authority(new_authority: Pubkey, previous: Pubkey, mint: Pubkey) -> Instruction {
        anchor_ix(
            "accept_authority",
            &[],
            vec![
                rs(new_authority),
                w(previous),
                r(mint),
                w(policy_pda(&mint)),
                w(pending_pda(&mint)),
            ],
        )
    }

    /// The accounts Token-2022 resolves from the meta list, in its order: policy, sender block,
    /// recipient block, recipient allow, transfer-authority block.
    pub fn hook_extras(
        mint: &Pubkey,
        from_owner: &Pubkey,
        to_owner: &Pubkey,
        authority: &Pubkey,
    ) -> Vec<Pubkey> {
        vec![
            policy_pda(mint),
            block_pda(mint, from_owner),
            block_pda(mint, to_owner),
            allow_pda(mint, to_owner),
            block_pda(mint, authority),
        ]
    }

    /// The transfer-hook interface's `Execute`, sent straight to Sentinel (not through a transfer).
    pub fn execute(
        source: Pubkey,
        mint: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
        extras: &[Pubkey],
        amount: u64,
    ) -> Instruction {
        let mut data = discriminator("spl-transfer-hook-interface:execute").to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts = vec![
            r(source),
            r(mint),
            r(destination),
            r(authority),
            r(meta_list_pda(&mint)),
        ];
        accounts.extend(extras.iter().map(|k| r(*k)));
        Instruction {
            program_id: SENTINEL_ID,
            accounts,
            data,
        }
    }

    /// The transfer-hook interface's own `InitializeExtraAccountMetas` with an empty list, as a
    /// generic client would send it to any hook program.
    pub fn interface_initialize_meta_list(authority: Pubkey, mint: Pubkey) -> Instruction {
        let mut data =
            discriminator("spl-transfer-hook-interface:initialize-extra-account-metas").to_vec();
        data.extend_from_slice(&0u32.to_le_bytes());
        Instruction {
            program_id: SENTINEL_ID,
            accounts: vec![
                w(meta_list_pda(&mint)),
                r(mint),
                ws(authority),
                r(SYSTEM_ID),
            ],
            data,
        }
    }

    /// Token-2022 `TransferChecked` (decimals 0) with the hook's accounts appended, as wallets
    /// build it after resolving the meta list.
    pub fn transfer(
        source: Pubkey,
        mint: Pubkey,
        destination: Pubkey,
        authority: Pubkey,
        extras: &[Pubkey],
        amount: u64,
    ) -> Instruction {
        let mut ix = spl_token_2022_interface::instruction::transfer_checked(
            &TOKEN_2022_ID,
            &source,
            &mint,
            &destination,
            &authority,
            &[],
            amount,
            0,
        )
        .unwrap();
        ix.accounts.extend(extras.iter().map(|k| r(*k)));
        ix.accounts.push(r(SENTINEL_ID));
        ix.accounts.push(r(meta_list_pda(&mint)));
        ix
    }
}

/// Send `ixs` signed by `payer` and `signers`; a fresh blockhash each time, so identical
/// transactions are not refused as duplicates. Keypairs the message does not need are ignored, and
/// a signer the message needs but nobody passed is left unsigned, so the runtime refuses it.
pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), FailedTransactionMetadata> {
    send_logs(svm, payer, signers, ixs).map(|_| ())
}

/// `send`, returning the program logs of a successful transaction.
pub fn send_logs(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, FailedTransactionMetadata> {
    svm.expire_blockhash();
    let mut tx = Transaction::new_unsigned(Message::new(ixs, Some(&payer.pubkey())));
    let required = &tx.message.account_keys[..tx.message.header.num_required_signatures as usize];
    let mut keys: Vec<&Keypair> = vec![payer];
    for s in signers {
        if required.contains(&s.pubkey()) && !keys.iter().any(|k| k.pubkey() == s.pubkey()) {
            keys.push(s);
        }
    }
    tx.try_partial_sign(&keys, svm.latest_blockhash())
        .expect("sign");
    svm.send_transaction(tx).map(|meta| meta.logs)
}

/// Standard base64 (with padding), enough for Anchor's `Program data:` logs.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut bits, mut n) = (0u32, 0);
    for c in text.trim_end_matches('=').bytes() {
        bits = (bits << 6) | ALPHABET.iter().position(|&a| a == c)? as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
        }
    }
    Some(out)
}

/// The payloads (after the 8-byte tag) of every event named `name` in `logs`, in order.
fn event_payloads(logs: &[String], name: &str) -> Vec<Vec<u8>> {
    let tag = discriminator(&format!("event:{name}"));
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: ").and_then(base64_decode))
        .filter(|data| data.len() >= 8 && data[..8] == tag)
        .map(|data| data[8..].to_vec())
        .collect()
}

/// Every `FreezeAuthorityChanged` event in `logs`, in order.
pub fn freeze_authority_events(logs: &[String]) -> Vec<FreezeChange> {
    event_payloads(logs, "FreezeAuthorityChanged")
        .into_iter()
        .map(|d| {
            let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
            let (new_freeze_authority, at) = match d[32] {
                0 => (None, 33),
                1 => (Some(key(33)), 65),
                other => panic!("bad Option tag {other}"),
            };
            assert_eq!(d.len(), at + 2 + 32 + 32, "FreezeAuthorityChanged size");
            FreezeChange {
                mint: key(0),
                new_freeze_authority,
                reason: Reason {
                    code: u16::from_le_bytes([d[at], d[at + 1]]),
                    case_ref: d[at + 2..at + 34].try_into().unwrap(),
                },
                authority: key(at + 34),
            }
        })
        .collect()
}

/// Every `EnforcementAction` event in `logs`, in order.
pub fn enforcement_events(logs: &[String]) -> Vec<Enforcement> {
    let mut events = Vec::new();
    for data in event_payloads(logs, "EnforcementAction") {
        let d = &data[..];
        assert_eq!(d.len(), 32 * 4 + 1 + 2 + 32, "EnforcementAction size");
        let key = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
        let action = match d[96] {
            0 => Action::Block,
            1 => Action::Unblock,
            2 => Action::Freeze,
            3 => Action::Thaw,
            other => panic!("unknown EnforcementKind {other}"),
        };
        events.push(Enforcement {
            mint: key(0),
            wallet: key(32),
            token_account: key(64),
            action,
            reason: Reason {
                code: u16::from_le_bytes([d[97], d[98]]),
                case_ref: d[99..131].try_into().unwrap(),
            },
            authority: key(131),
        });
    }
    events
}

/// The custom error code of a failed transaction, if it has one.
pub fn custom_code(err: &FailedTransactionMetadata) -> Option<u32> {
    match &err.err {
        TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
        _ => None,
    }
}

pub fn fund(svm: &mut LiteSVM, key: &Pubkey, lamports: u64) {
    svm.airdrop(key, lamports).expect("airdrop");
}

/// A mint (decimals 0) whose transfer hook is Sentinel, whose mint authority is `issuer`, and whose
/// freeze authority is `freeze_authority`.
pub fn create_hooked_mint(
    svm: &mut LiteSVM,
    issuer: &Keypair,
    mint: Keypair,
    freeze_authority: Option<&Pubkey>,
) -> Keypair {
    let len =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let rent = svm.minimum_balance_for_rent_exemption(len);
    let create = solana_system_interface::instruction::create_account(
        &issuer.pubkey(),
        &mint.pubkey(),
        rent,
        len as u64,
        &TOKEN_2022_ID,
    );
    let hook = transfer_hook::instruction::initialize(
        &TOKEN_2022_ID,
        &mint.pubkey(),
        Some(issuer.pubkey()),
        Some(SENTINEL_ID),
    )
    .unwrap();
    let init = spl_token_2022_interface::instruction::initialize_mint2(
        &TOKEN_2022_ID,
        &mint.pubkey(),
        &issuer.pubkey(),
        freeze_authority,
        0,
    )
    .unwrap();
    send(svm, issuer, &[&mint], &[create, hook, init]).expect("create mint");
    mint
}

/// A token account of `mint` owned by `owner` (a keypair account, not an ATA).
pub fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    // A mint with a transfer hook requires this extension on each of its token accounts.
    let len = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
        ExtensionType::TransferHookAccount,
    ])
    .unwrap();
    let rent = svm.minimum_balance_for_rent_exemption(len);
    let create = solana_system_interface::instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        rent,
        len as u64,
        &TOKEN_2022_ID,
    );
    let init = spl_token_2022_interface::instruction::initialize_account3(
        &TOKEN_2022_ID,
        &account.pubkey(),
        mint,
        owner,
    )
    .unwrap();
    send(svm, payer, &[&account], &[create, init]).expect("create token account");
    account.pubkey()
}

pub fn mint_to(svm: &mut LiteSVM, issuer: &Keypair, mint: &Pubkey, account: &Pubkey, amount: u64) {
    let ix = spl_token_2022_interface::instruction::mint_to_checked(
        &TOKEN_2022_ID,
        mint,
        account,
        &issuer.pubkey(),
        &[],
        amount,
        0,
    )
    .unwrap();
    send(svm, issuer, &[], &[ix]).expect("mint_to");
}

/// Token-2022 `ApproveChecked` (decimals 0).
pub fn approve_ix(
    owner: &Pubkey,
    mint: &Pubkey,
    account: &Pubkey,
    delegate: &Pubkey,
    amount: u64,
) -> Instruction {
    spl_token_2022_interface::instruction::approve_checked(
        &TOKEN_2022_ID,
        account,
        mint,
        delegate,
        owner,
        &[],
        amount,
        0,
    )
    .unwrap()
}

/// Token-2022 `SetAuthority` naming `new` as the mint's freeze authority, signed by `current`.
pub fn set_freeze_authority_ix(mint: &Pubkey, current: &Pubkey, new: &Pubkey) -> Instruction {
    spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022_ID,
        mint,
        Some(new),
        spl_token_2022_interface::instruction::AuthorityType::FreezeAccount,
        current,
        &[],
    )
    .unwrap()
}

/// Balance, delegate and delegated amount of a token account.
pub fn token_state(svm: &LiteSVM, account: &Pubkey) -> (u64, Option<Pubkey>, u64) {
    let data = svm.get_account(account).expect("token account").data;
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    let delegate = if u32::from_le_bytes(data[72..76].try_into().unwrap()) == 1 {
        Some(Pubkey::new_from_array(data[76..108].try_into().unwrap()))
    } else {
        None
    };
    let delegated = u64::from_le_bytes(data[121..129].try_into().unwrap());
    (amount, delegate, delegated)
}

/// Whether a token account is frozen (`AccountState::Frozen` in its `state` byte).
pub fn is_frozen(svm: &LiteSVM, account: &Pubkey) -> bool {
    svm.get_account(account).expect("token account").data[108] == 2
}

/// The mint's freeze authority.
pub fn freeze_authority_of(svm: &LiteSVM, mint: &Pubkey) -> Option<Pubkey> {
    let data = svm.get_account(mint).expect("mint").data;
    (u32::from_le_bytes(data[46..50].try_into().unwrap()) == 1)
        .then(|| Pubkey::new_from_array(data[50..82].try_into().unwrap()))
}

/// An account owned by Sentinel with data, i.e. a live PDA.
pub fn sentinel_account(svm: &LiteSVM, key: &Pubkey) -> Option<Account> {
    svm.get_account(key)
        .filter(|a| a.owner == SENTINEL_ID && !a.data.is_empty())
}

/// The decoded `PolicyConfig`.
#[derive(Debug, PartialEq, Eq)]
pub struct Policy {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub rules: Rules,
}

pub fn read_policy(svm: &LiteSVM, mint: &Pubkey) -> Option<Policy> {
    let data = sentinel_account(svm, &policy_pda(mint))?.data;
    let key = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
    Some(Policy {
        mint: key(8),
        authority: key(40),
        rules: Rules {
            allowlist: data[72] == 1,
            blocklist: data[73] == 1,
            max_transfer_amount: u64::from_le_bytes(data[74..82].try_into().unwrap()),
            allow_confidential: data[82] == 1,
        },
    })
}

/// The `new_authority` of a pending handover.
pub fn read_pending(svm: &LiteSVM, mint: &Pubkey) -> Option<Pubkey> {
    let data = sentinel_account(svm, &pending_pda(mint))?.data;
    Some(Pubkey::new_from_array(data[40..72].try_into().unwrap()))
}
