// SPDX-License-Identifier: Apache-2.0
//! Model-based fuzzing of Sentinel.
//!
//! Each case sets up a mint whose transfer hook is Sentinel, then runs a random sequence of
//! operations: every Sentinel instruction, signed by the right authority or by someone else; public
//! transfers through Token-2022, by owners and by delegates; approvals; direct calls to the hook
//! (public and confidential amounts, and with made-up accounts); and strangers funding the
//! program's addresses before setup. A plain Rust model predicts each outcome. After every
//! operation the test checks that
//!
//! - the outcome matches the model (success, or the exact Sentinel error where the model names one),
//! - the policy, the allow and block entries, a pending handover, every balance and delegation, and
//!   the meta list are exactly what the model says,
//! - the total supply is unchanged by transfers.
//!
//! The model is the threat model's invariants written as code (`docs/threat-model.md`):
//! fail closed (1), only the policy authority changes rules (2), only the mint authority sets up (3),
//! handover needs both sides (4), blocklist (5), allowlist (6), limit and confidential amounts (7),
//! entries cannot be forged (8), the hook holds no state (9).
//!
//! `FUZZ_CASES` (default 64), `FUZZ_STEPS` (default 60) and `FUZZ_SEED` (default fixed) set the run.
//! A failure prints the seed, the case and the operations that led to it.

mod common;

use std::collections::BTreeSet;
use std::fmt;

use common::*;
use litesvm::LiteSVM;
use solana_address::Address as Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// SplitMix64: small, fast and reproducible from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

const WALLETS: usize = 5;
const CONFIDENTIAL: u64 = u64::MAX;

/// What the model expects of one operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    Ok,
    /// Fails with this custom error code.
    Code(u32),
    /// Fails; the model does not pin down which error.
    Err,
}

/// Who signs or is named: the issuer (mint authority), wallet `i`, or an address nobody holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Who {
    Issuer,
    Wallet(usize),
    Nobody,
}

#[derive(Clone, Debug)]
enum Op {
    InitPolicy {
        signer: Who,
        rules: Rules,
    },
    InitMetaList {
        signer: Who,
    },
    UpdatePolicy {
        signer: Who,
        rules: Rules,
    },
    UpdateMetaList {
        signer: Who,
    },
    AddEntry {
        block: bool,
        signer: Who,
        wallet: Who,
    },
    RemoveEntry {
        block: bool,
        signer: Who,
        wallet: Who,
    },
    Propose {
        signer: Who,
        new_authority: ProposeTo,
    },
    Cancel {
        signer: Who,
    },
    Accept {
        signer: Who,
        previous: Who,
    },
    Approve {
        owner: usize,
        delegate: Who,
        amount: u64,
    },
    Transfer {
        from: usize,
        to: usize,
        authority: Who,
        amount: u64,
    },
    /// `Execute` sent straight to Sentinel with the accounts Token-2022 would resolve.
    Execute {
        from: usize,
        to: usize,
        authority: Who,
        amount: u64,
        /// What goes in the fifth extra account, the transfer authority's block entry.
        fifth: Fifth,
    },
    /// The transfer-hook interface's `InitializeExtraAccountMetas`, which Sentinel must refuse: its
    /// meta list is created only by its own instruction, which checks the mint authority.
    InterfaceInit {
        signer: Who,
    },
    /// `Execute` sent straight to Sentinel with made-up accounts.
    ExecuteGarbage {
        amount: u64,
        seed: u64,
    },
    /// A stranger funds the policy or meta-list address before it exists.
    Prefund {
        meta_list: bool,
        lamports: u64,
    },
}

/// The fifth extra account of a direct `Execute`. Token-2022 always passes the authority's own
/// block entry; a direct caller can pass anything, and the hook must check it by content
/// (invariant 8): only this mint's `BlockEntry` for this authority may block.
#[derive(Clone, Copy, Debug)]
enum Fifth {
    Resolved,
    /// The policy account: owned by Sentinel, but not a `BlockEntry`.
    Policy,
    /// Someone's block entry address, perhaps not the authority's.
    EntryOf(Who),
}

#[derive(Clone, Copy, Debug)]
enum ProposeTo {
    Who(Who),
    Default,
    Current,
}

struct World {
    svm: LiteSVM,
    issuer: Keypair,
    wallets: Vec<Keypair>,
    nobody: Pubkey,
    mint: Pubkey,
    accounts: Vec<Pubkey>,
    meta_list_bytes: Option<Vec<u8>>,
}

impl World {
    fn key(&self, who: Who) -> Pubkey {
        match who {
            Who::Issuer => self.issuer.pubkey(),
            Who::Wallet(i) => self.wallets[i].pubkey(),
            Who::Nobody => self.nobody,
        }
    }
    fn keypair(&self, who: Who) -> &Keypair {
        match who {
            Who::Issuer => &self.issuer,
            Who::Wallet(i) => &self.wallets[i],
            Who::Nobody => unreachable!("nobody holds this key"),
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Model {
    policy: Option<(Pubkey, Rules)>,
    meta_list: bool,
    pending: Option<Pubkey>,
    allow: BTreeSet<Pubkey>,
    block: BTreeSet<Pubkey>,
    balances: Vec<u64>,
    delegations: Vec<Option<(Pubkey, u64)>>,
    supply: u64,
}

impl Model {
    /// The hook's verdict on a transfer from `from_owner` to `to_owner` moved by `authority`.
    /// `check_authority`: whether the hook receives the transfer authority's own block entry.
    fn hook(
        &self,
        from_owner: Pubkey,
        to_owner: Pubkey,
        authority: Pubkey,
        amount: u64,
        check_authority: bool,
    ) -> Expect {
        let Some((_, rules)) = self.policy else {
            return Expect::Err; // fail closed: no policy, no transfer
        };
        if rules.max_transfer_amount > 0 {
            if amount == CONFIDENTIAL {
                if !rules.allow_confidential {
                    return Expect::Code(code::CONFIDENTIAL_AMOUNT_NOT_ENFORCEABLE);
                }
            } else if amount > rules.max_transfer_amount {
                return Expect::Code(code::TRANSFER_EXCEEDS_LIMIT);
            }
        }
        if rules.blocklist {
            if self.block.contains(&from_owner) {
                return Expect::Code(code::SENDER_BLOCKED);
            }
            if self.block.contains(&to_owner) {
                return Expect::Code(code::RECIPIENT_BLOCKED);
            }
            if check_authority && self.block.contains(&authority) {
                return Expect::Code(code::AUTHORITY_BLOCKED);
            }
        }
        if rules.allowlist && !self.allow.contains(&to_owner) {
            return Expect::Code(code::RECIPIENT_NOT_ALLOWLISTED);
        }
        Expect::Ok
    }

    fn authority(&self) -> Option<Pubkey> {
        self.policy.map(|(a, _)| a)
    }
}

fn random_rules(rng: &mut Rng) -> Rules {
    Rules {
        allowlist: rng.chance(40),
        blocklist: rng.chance(60),
        max_transfer_amount: match rng.below(4) {
            0 | 1 => 0,
            2 => 1 + rng.below(300),
            _ => 1 + rng.below(1_000),
        },
        allow_confidential: rng.chance(50),
    }
}

fn random_who(rng: &mut Rng, model: &Model, world: &World) -> Who {
    // Bias towards the people who matter: the current authority and a pending one.
    let authority = model.authority();
    let pending = model.pending;
    match rng.below(10) {
        0..=3 => match authority {
            Some(a) => who_of(world, a),
            None => Who::Issuer,
        },
        4 => match pending {
            Some(p) => who_of(world, p),
            None => Who::Issuer,
        },
        5 => Who::Issuer,
        6 if rng.chance(30) => Who::Nobody,
        _ => Who::Wallet(rng.below(WALLETS as u64) as usize),
    }
}

fn who_of(world: &World, key: Pubkey) -> Who {
    if key == world.issuer.pubkey() {
        return Who::Issuer;
    }
    for (i, w) in world.wallets.iter().enumerate() {
        if w.pubkey() == key {
            return Who::Wallet(i);
        }
    }
    Who::Nobody
}

fn random_amount(rng: &mut Rng, balance: u64, model: &Model) -> u64 {
    let limit = model
        .policy
        .map(|(_, r)| r.max_transfer_amount)
        .unwrap_or(0);
    match rng.below(8) {
        0 => 0,
        1 => 1,
        2 => balance,
        3 => balance + 1,
        4 if limit > 0 => limit,
        5 if limit > 0 => limit + 1,
        _ => rng.below(balance.max(1) + 1),
    }
}

fn random_op(rng: &mut Rng, model: &Model, world: &World) -> Op {
    let wallet = |rng: &mut Rng| rng.below(WALLETS as u64) as usize;
    match rng.below(100) {
        0..=29 => {
            let from = wallet(rng);
            let to = if rng.chance(10) { from } else { wallet(rng) };
            // Mostly the owner; else the account's delegate when it has one, so delegated
            // transfers (and a blocklisted delegate) come up often.
            let authority = match model.delegations[from] {
                Some((d, _)) if rng.chance(40) => who_of(world, d),
                _ if rng.chance(80) => Who::Wallet(from),
                _ => random_who(rng, model, world),
            };
            let amount = random_amount(rng, model.balances[from], model);
            Op::Transfer {
                from,
                to,
                authority,
                amount,
            }
        }
        30..=37 => {
            let from = wallet(rng);
            let to = wallet(rng);
            let authority = if rng.chance(60) {
                Who::Wallet(from)
            } else {
                random_who(rng, model, world)
            };
            let amount = if rng.chance(50) {
                CONFIDENTIAL
            } else {
                random_amount(rng, model.balances[from], model)
            };
            let fifth = match rng.below(100) {
                0..=84 => Fifth::Resolved,
                85..=91 => Fifth::Policy,
                _ => Fifth::EntryOf(random_who(rng, model, world)),
            };
            Op::Execute {
                from,
                to,
                authority,
                amount,
                fifth,
            }
        }
        38 => Op::InterfaceInit {
            signer: random_who(rng, model, world),
        },
        39..=40 => Op::ExecuteGarbage {
            amount: if rng.chance(50) {
                CONFIDENTIAL
            } else {
                rng.below(2_000)
            },
            seed: rng.next(),
        },
        41..=46 => {
            // Another wallet (those are what the lists name most), sometimes the issuer.
            let owner = wallet(rng);
            let delegate = if rng.chance(15) {
                Who::Issuer
            } else {
                Who::Wallet((owner + 1 + rng.below(WALLETS as u64 - 1) as usize) % WALLETS)
            };
            Op::Approve {
                owner,
                delegate,
                amount: rng.below(model.balances[owner] + 2),
            }
        }
        47..=53 => Op::UpdatePolicy {
            signer: random_who(rng, model, world),
            rules: random_rules(rng),
        },
        54..=73 => {
            let block = rng.chance(55);
            let signer = random_who(rng, model, world);
            let target = if rng.chance(85) {
                Who::Wallet(wallet(rng))
            } else {
                rng.pick(&[Who::Issuer, Who::Nobody])
            };
            let set = if block { &model.block } else { &model.allow };
            // Remove what is there more often than not, so lists shrink as well as grow.
            if set.contains(&world.key(target)) && rng.chance(60) {
                Op::RemoveEntry {
                    block,
                    signer,
                    wallet: target,
                }
            } else if rng.chance(80) {
                Op::AddEntry {
                    block,
                    signer,
                    wallet: target,
                }
            } else {
                Op::RemoveEntry {
                    block,
                    signer,
                    wallet: target,
                }
            }
        }
        74..=78 => {
            let new_authority = match rng.below(10) {
                0 => ProposeTo::Default,
                1 => ProposeTo::Current,
                2 => ProposeTo::Who(Who::Nobody),
                _ => ProposeTo::Who(random_who(rng, model, world)),
            };
            Op::Propose {
                signer: random_who(rng, model, world),
                new_authority,
            }
        }
        79..=80 => Op::Cancel {
            signer: random_who(rng, model, world),
        },
        81..=84 => {
            let signer = match model.pending {
                Some(p) if rng.chance(70) => who_of(world, p),
                _ => random_who(rng, model, world),
            };
            // The account that gets the proposal's rent back must be the outgoing authority; try
            // someone else often enough that a missing check shows.
            let previous = match model.authority() {
                Some(a) if rng.chance(65) => who_of(world, a),
                _ => Who::Wallet(rng.below(WALLETS as u64) as usize),
            };
            Op::Accept { signer, previous }
        }
        85..=87 => Op::UpdateMetaList {
            signer: random_who(rng, model, world),
        },
        88..=91 => Op::InitPolicy {
            signer: random_who(rng, model, world),
            rules: random_rules(rng),
        },
        92..=95 => Op::InitMetaList {
            signer: random_who(rng, model, world),
        },
        _ => Op::Prefund {
            meta_list: rng.chance(50),
            lamports: rng.pick(&[1_000_000, 890_880, 5_000_000, 100_000_000]),
        },
    }
}

impl fmt::Display for Op {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Predict `op`, run it, update the model, and check the outcome.
/// Returns what the model expected, for the summary.
fn step(world: &mut World, model: &mut Model, op: &Op) -> Result<Expect, String> {
    let mint = world.mint;
    let signer_ok = |who: Who| who != Who::Nobody;
    let (expect, ixs, signers): (Expect, Vec<solana_instruction::Instruction>, Vec<Who>) = match op
        .clone()
    {
        Op::InitPolicy { signer, rules } => {
            let s = world.key(signer);
            let expect = if !signer_ok(signer) {
                Expect::Err
            } else if s != world.issuer.pubkey() {
                if model.policy.is_some() {
                    Expect::Err
                } else {
                    Expect::Code(code::UNAUTHORIZED)
                }
            } else if model.policy.is_some() {
                Expect::Err
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.policy = Some((s, rules));
            }
            (
                expect,
                vec![ix::initialize_policy(s, mint, rules)],
                vec![signer],
            )
        }
        Op::InitMetaList { signer } => {
            let s = world.key(signer);
            let expect = if !signer_ok(signer) {
                Expect::Err
            } else if s != world.issuer.pubkey() {
                Expect::Code(code::UNAUTHORIZED)
            } else if model.meta_list {
                Expect::Err
            } else {
                Expect::Ok
            };
            if expect == Expect::Ok {
                model.meta_list = true;
            }
            (
                expect,
                vec![ix::initialize_meta_list(s, mint)],
                vec![signer],
            )
        }
        Op::UpdatePolicy { signer, rules } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.policy = Some((s, rules));
            }
            (
                expect,
                vec![ix::update_policy(s, mint, rules)],
                vec![signer],
            )
        }
        Op::UpdateMetaList { signer } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) => Expect::Err,
                Some(_) if !model.meta_list => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            (expect, vec![ix::update_meta_list(s, mint)], vec![signer])
        }
        Op::AddEntry {
            block,
            signer,
            wallet,
        } => {
            let s = world.key(signer);
            let w = world.key(wallet);
            let exists = if block {
                model.block.contains(&w)
            } else {
                model.allow.contains(&w)
            };
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || exists => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                if block {
                    model.block.insert(w);
                } else {
                    model.allow.insert(w);
                }
            }
            (
                expect,
                vec![ix::add_to_list(block, s, mint, w)],
                vec![signer],
            )
        }
        Op::RemoveEntry {
            block,
            signer,
            wallet,
        } => {
            let s = world.key(signer);
            let w = world.key(wallet);
            let exists = if block {
                model.block.contains(&w)
            } else {
                model.allow.contains(&w)
            };
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || !exists => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                if block {
                    model.block.remove(&w);
                } else {
                    model.allow.remove(&w);
                }
            }
            (
                expect,
                vec![ix::remove_from_list(block, s, mint, w)],
                vec![signer],
            )
        }
        Op::Propose {
            signer,
            new_authority,
        } => {
            let s = world.key(signer);
            let new = match new_authority {
                ProposeTo::Who(w) => world.key(w),
                ProposeTo::Default => Pubkey::default(),
                ProposeTo::Current => model.authority().unwrap_or(s),
            };
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || model.pending.is_some() => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some((a, _)) if new == Pubkey::default() || new == a => {
                    Expect::Code(code::INVALID_AUTHORITY)
                }
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.pending = Some(new);
            }
            (
                expect,
                vec![ix::propose_authority(s, mint, new)],
                vec![signer],
            )
        }
        Op::Cancel { signer } => {
            let s = world.key(signer);
            let expect = match model.policy {
                None => Expect::Err,
                Some(_) if !signer_ok(signer) || model.pending.is_none() => Expect::Err,
                Some((a, _)) if a != s => Expect::Code(code::UNAUTHORIZED),
                Some(_) => Expect::Ok,
            };
            if expect == Expect::Ok {
                model.pending = None;
            }
            (
                expect,
                vec![ix::cancel_authority_transfer(s, mint)],
                vec![signer],
            )
        }
        Op::Accept { signer, previous } => {
            let s = world.key(signer);
            let p = world.key(previous);
            let expect = match (model.policy, model.pending) {
                (None, _) | (_, None) => Expect::Err,
                _ if !signer_ok(signer) => Expect::Err,
                (Some((a, _)), _) if a != p => Expect::Code(code::UNAUTHORIZED),
                (_, Some(n)) if n != s => Expect::Code(code::UNAUTHORIZED),
                _ => Expect::Ok,
            };
            if expect == Expect::Ok {
                let rules = model.policy.unwrap().1;
                model.policy = Some((s, rules));
                model.pending = None;
            }
            (expect, vec![ix::accept_authority(s, p, mint)], vec![signer])
        }
        Op::Approve {
            owner,
            delegate,
            amount,
        } => {
            let d = world.key(delegate);
            approve(
                &mut world.svm,
                &world.issuer,
                &world.wallets[owner],
                &mint,
                &world.accounts[owner],
                &d,
                amount,
            );
            model.delegations[owner] = Some((d, amount));
            return check_state(world, model).map(|()| Expect::Ok);
        }
        Op::Transfer {
            from,
            to,
            authority,
            amount,
        } => {
            let a = world.key(authority);
            let from_owner = world.wallets[from].pubkey();
            let to_owner = world.wallets[to].pubkey();
            let delegated = match model.delegations[from] {
                Some((d, allowance)) if d == a => Some(allowance),
                _ => None,
            };
            let token_ok = signer_ok(authority)
                && amount <= model.balances[from]
                && match delegated {
                    Some(allowance) => allowance >= amount,
                    None => a == from_owner,
                };
            let expect = if !token_ok {
                Expect::Err
            } else if from == to {
                // Token-2022 returns before calling the hook on a self-transfer: nothing moves.
                Expect::Ok
            } else if !model.meta_list {
                Expect::Err // fail closed: Token-2022 cannot resolve the hook's accounts
            } else {
                model.hook(from_owner, to_owner, a, amount, true)
            };
            if expect == Expect::Ok && from != to {
                model.balances[from] -= amount;
                model.balances[to] += amount;
                if let Some(allowance) = delegated {
                    let left = allowance - amount;
                    model.delegations[from] = if left == 0 { None } else { Some((a, left)) };
                }
            }
            let extras = ix::hook_extras(&mint, &from_owner, &to_owner, &a);
            let ix = ix::transfer(
                world.accounts[from],
                mint,
                world.accounts[to],
                a,
                &extras,
                amount,
            );
            (expect, vec![ix], vec![authority])
        }
        Op::Execute {
            from,
            to,
            authority,
            amount,
            fifth,
        } => {
            let a = world.key(authority);
            let from_owner = world.wallets[from].pubkey();
            let to_owner = world.wallets[to].pubkey();
            // A direct call needs no meta list (the hook checks only the list's address) and no
            // signature; the verdict must match the model, and nothing may change (invariant 9).
            let mut extras = ix::hook_extras(&mint, &from_owner, &to_owner, &a);
            let check_authority = match fifth {
                Fifth::Resolved => true,
                Fifth::Policy => {
                    extras[4] = policy_pda(&mint);
                    false
                }
                Fifth::EntryOf(w) => {
                    extras[4] = block_pda(&mint, &world.key(w));
                    world.key(w) == a
                }
            };
            let expect = model.hook(from_owner, to_owner, a, amount, check_authority);
            let ix = ix::execute(
                world.accounts[from],
                mint,
                world.accounts[to],
                a,
                &extras,
                amount,
            );
            (expect, vec![ix], vec![])
        }
        Op::InterfaceInit { signer } => {
            let s = world.key(signer);
            (
                Expect::Err,
                vec![ix::interface_initialize_meta_list(s, mint)],
                vec![signer],
            )
        }
        Op::ExecuteGarbage { amount, seed } => {
            let mut rng = Rng(seed);
            let mut candidates: Vec<Pubkey> = world.accounts.clone();
            candidates.extend(world.wallets.iter().map(|w| w.pubkey()));
            candidates.push(policy_pda(&mint));
            candidates.push(meta_list_pda(&mint));
            for w in &world.wallets {
                candidates.push(block_pda(&mint, &w.pubkey()));
                candidates.push(allow_pda(&mint, &w.pubkey()));
            }
            candidates.push(Keypair::new().pubkey());
            let n = candidates.len() as u64;
            let picks: Vec<Pubkey> = (0..9).map(|_| candidates[rng.below(n) as usize]).collect();
            let extras = &picks[3..3 + rng.below(6) as usize];
            let ix = ix::execute(picks[0], mint, picks[1], picks[2], extras, amount);
            let result = send(&mut world.svm, &world.issuer, &[], &[ix]);
            let _ = result; // any verdict; what matters is that nothing changed
            return check_state(world, model).map(|()| Expect::Ok);
        }
        Op::Prefund {
            meta_list,
            lamports,
        } => {
            let target = if meta_list {
                meta_list_pda(&mint)
            } else {
                policy_pda(&mint)
            };
            let exists = if meta_list {
                model.meta_list
            } else {
                model.policy.is_some()
            };
            if exists {
                return check_state(world, model).map(|()| Expect::Ok);
            }
            let ix = solana_system_interface::instruction::transfer(
                &world.wallets[4].pubkey(),
                &target,
                lamports,
            );
            send(&mut world.svm, &world.wallets[4], &[], &[ix])
                .map_err(|e| format!("prefund: {e:?}"))?;
            return check_state(world, model).map(|()| Expect::Ok);
        }
    };

    // `Nobody` has no keypair: its signature stays missing and the runtime refuses the transaction.
    let keypairs: Vec<Keypair> = signers
        .iter()
        .filter(|w| **w != Who::Nobody)
        .map(|w| world.keypair(*w).insecure_clone())
        .collect();
    let refs: Vec<&Keypair> = keypairs.iter().collect();
    let issuer = world.issuer.insecure_clone();
    let result = send(&mut world.svm, &issuer, &refs, &ixs);
    let ok = match (&result, expect) {
        (Ok(()), Expect::Ok) => true,
        (Err(e), Expect::Code(c)) => custom_code(e) == Some(c),
        (Err(_), Expect::Err) => true,
        _ => false,
    };
    if !ok {
        let got = match &result {
            Ok(()) => "Ok".to_string(),
            Err(e) => format!("{:?}\n    logs: {:#?}", e.err, e.meta.logs),
        };
        return Err(format!("expected {expect:?}, got {got}"));
    }
    if expect == Expect::Ok {
        if let Op::InitMetaList { .. } | Op::UpdateMetaList { .. } = op {
            world.meta_list_bytes =
                sentinel_account(&world.svm, &meta_list_pda(&mint)).map(|a| a.data);
        }
    }
    check_state(world, model).map(|()| expect)
}

/// The chain must hold exactly what the model says.
fn check_state(world: &World, model: &Model) -> Result<(), String> {
    let mint = world.mint;
    let svm = &world.svm;
    let policy = read_policy(svm, &mint);
    match (&policy, model.policy) {
        (None, None) => {}
        (Some(p), Some((authority, rules))) => {
            if p.mint != mint || p.authority != authority || p.rules != rules {
                return Err(format!("policy {p:?}, model {:?}", model.policy));
            }
        }
        _ => return Err(format!("policy {policy:?}, model {:?}", model.policy)),
    }
    let pending = read_pending(svm, &mint);
    if pending != model.pending {
        return Err(format!("pending {pending:?}, model {:?}", model.pending));
    }
    let mut people: Vec<Pubkey> = world.wallets.iter().map(|w| w.pubkey()).collect();
    people.push(world.issuer.pubkey());
    people.push(world.nobody);
    for p in &people {
        let allow = sentinel_account(svm, &allow_pda(&mint, p)).is_some();
        let block = sentinel_account(svm, &block_pda(&mint, p)).is_some();
        if allow != model.allow.contains(p) || block != model.block.contains(p) {
            return Err(format!(
                "entries of {p}: allow {allow} block {block}, model allow {} block {}",
                model.allow.contains(p),
                model.block.contains(p)
            ));
        }
    }
    let meta = sentinel_account(svm, &meta_list_pda(&mint)).map(|a| a.data);
    if meta.is_some() != model.meta_list {
        return Err(format!(
            "meta list exists: {}, model {}",
            meta.is_some(),
            model.meta_list
        ));
    }
    if meta != world.meta_list_bytes {
        return Err("meta list bytes changed outside init/update".into());
    }
    let mut total = 0;
    for (i, account) in world.accounts.iter().enumerate() {
        let (amount, delegate, delegated) = token_state(svm, account);
        total += amount;
        let model_delegation = model.delegations[i];
        let chain_delegation = delegate.map(|d| (d, delegated));
        if amount != model.balances[i] || chain_delegation != model_delegation {
            return Err(format!(
                "wallet {i}: balance {amount} delegation {chain_delegation:?}, model {} {model_delegation:?}",
                model.balances[i]
            ));
        }
    }
    if total != model.supply {
        return Err(format!("supply {total}, model {}", model.supply));
    }
    Ok(())
}

fn setup(rng: &mut Rng) -> (World, Model, Vec<Op>) {
    let mut svm = svm();
    let issuer = Keypair::new();
    let wallets: Vec<Keypair> = (0..WALLETS).map(|_| Keypair::new()).collect();
    fund(&mut svm, &issuer.pubkey(), 1_000_000_000_000);
    for w in &wallets {
        fund(&mut svm, &w.pubkey(), 100_000_000_000);
    }
    let mint = create_hooked_mint(&mut svm, &issuer).pubkey();
    let accounts: Vec<Pubkey> = wallets
        .iter()
        .map(|w| create_token_account(&mut svm, &issuer, &mint, &w.pubkey()))
        .collect();
    let mut model = Model {
        balances: vec![0; WALLETS],
        delegations: vec![None; WALLETS],
        ..Model::default()
    };
    for (i, account) in accounts.iter().enumerate() {
        let amount = rng.below(1_000);
        if amount > 0 {
            mint_to(&mut svm, &issuer, &mint, account, amount);
        }
        model.balances[i] = amount;
        model.supply += amount;
    }
    let world = World {
        svm,
        issuer,
        wallets,
        nobody: Keypair::new().pubkey(),
        mint,
        accounts,
        meta_list_bytes: None,
    };
    // Most cases start set up; some start bare (fail closed) or with pre-funded addresses.
    let mut ops = Vec::new();
    if rng.chance(15) {
        ops.push(Op::Prefund {
            meta_list: true,
            lamports: rng.pick(&[890_880, 10_000_000]),
        });
    }
    if rng.chance(10) {
        ops.push(Op::Prefund {
            meta_list: false,
            lamports: 890_880,
        });
    }
    if rng.chance(85) {
        ops.push(Op::InitPolicy {
            signer: Who::Issuer,
            rules: random_rules(rng),
        });
    }
    if rng.chance(85) {
        ops.push(Op::InitMetaList {
            signer: Who::Issuer,
        });
    }
    (world, model, ops)
}

#[test]
fn sentinel_matches_its_model() {
    let cases: u64 = std::env::var("FUZZ_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(64);
    let steps: u64 = std::env::var("FUZZ_STEPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let seed: u64 = std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x05E1_71E1);
    let mut totals = std::collections::BTreeMap::<String, u64>::new();
    for case in 0..cases {
        let case_seed = seed.wrapping_add(case.wrapping_mul(0x9E37_79B9));
        let mut rng = Rng(case_seed);
        let (mut world, mut model, mut ops) = setup(&mut rng);
        let first = ops.len();
        let mut history: Vec<String> = Vec::new();
        for n in 0..(first as u64 + steps) {
            let op = if (n as usize) < first {
                ops[n as usize].clone()
            } else {
                random_op(&mut rng, &model, &world)
            };
            let name = format!("{op:?}")
                .split([' ', '{'])
                .next()
                .unwrap()
                .to_string();
            let before = model.clone();
            let result = step(&mut world, &mut model, &op);
            let outcome = match &result {
                Ok(Expect::Ok) => "ok".to_string(),
                Ok(Expect::Code(c)) => format!("error {c}"),
                Ok(Expect::Err) | Err(_) => "error".to_string(),
            };
            *totals.entry(format!("{name} {outcome}")).or_default() += 1;
            history.push(format!("{op}"));
            if let Err(why) = result {
                panic!(
                    "case {case} (FUZZ_SEED={seed}, case seed {case_seed}), step {n}: {why}\n  op: {op}\n  model before: {before:?}\n  last operations:\n    {}",
                    history.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n    ")
                );
            }
        }
        ops.clear();
    }
    let total: u64 = totals.values().sum();
    println!("{cases} cases, {total} operations, all matched the model:");
    for (name, n) in totals {
        println!("  {name:<28} {n}");
    }
}
