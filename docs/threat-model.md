# Sentinel threat model

Version 2.3.0, 16 October 2026 (first written for 2.1.0, 12 October). Written by the author as
part of a self-review. Sentinel has not
been independently audited; this document is meant to make that audit faster and cheaper.

## Scope

The on-chain program in `programs/sentinel/src/lib.rs`: one file, about 990 lines of Rust without
blank lines and comments, built with Anchor 0.31.1. Eighteen instructions: `initialize_policy`,
`update_policy`, `initialize_extra_account_meta_list`, `update_extra_account_meta_list`,
`add_to_allowlist`, `remove_from_allowlist`, `add_to_blocklist`, `remove_from_blocklist`,
`block_wallet`, `unblock_wallet`, `freeze_token_account`, `thaw_token_account`,
`set_freeze_authority`, `propose_authority`, `cancel_authority_transfer`, `accept_authority`, `transfer_hook`, and the
`fallback` that routes Token-2022's `Execute` call to `transfer_hook`.

Out of scope: the TypeScript SDK in `sdk/` (it only builds instructions; the program does not
trust it), Token-2022 itself, and the ZK ElGamal Proof Program.

## What Sentinel protects

An issuer's rules for one Token-2022 mint, enforced on every transfer of that mint:

- **Allowlist**: when on, a transfer is refused unless the recipient (the owner of the destination
  token account) has an allow entry.
- **Blocklist**: when on, a transfer is refused if the sender, the recipient, or the authority
  signing the transfer (a delegate) has a block entry.
- **Limit**: a public transfer above `max_transfer_amount` is refused. A confidential transfer
  hides its amount from the hook; on a mint with a limit it is refused unless the issuer has set
  `allow_confidential`.
- **Freeze** (2.2): on a mint whose freeze authority is Sentinel's freeze address
  (`["freeze-authority", mint]`), the policy authority can freeze and thaw any token account of the
  mint through Sentinel. Token-2022 then refuses every instruction on a frozen account: transfers in
  and out, burns, approvals, and the confidential deposit, transfer and withdraw. Since 2.3 the
  policy authority can also hand the freeze authority on to another address, or give it up, with
  `set_freeze_authority`.
- **Record** (2.2): `block_wallet`, `unblock_wallet`, `freeze_token_account` and
  `thaw_token_account` take the issuer's reason code and a 32-byte case reference and put them,
  with who did what to whom, in an `EnforcementAction` event. `set_freeze_authority` (2.3) does
  the same in a `FreezeAuthorityChanged` event.

The state that carries these rules: one `PolicyConfig` per mint, one `AllowEntry` or `BlockEntry`
per listed wallet, the mint's `ExtraAccountMetaList`, and a `PendingAuthority` while a handover is
in progress. All are PDAs of the program, seeded by the mint. The freeze address holds no data; it
only signs. A token account's frozen state lives in the token account, kept by Token-2022.

## Who is trusted

| Actor | Trust | What it can do |
|---|---|---|
| Policy authority | Fully trusted for its mint | Change the rules and the lists, hand the policy over, rewrite the meta list. It can also stop every transfer of the mint (for example, allowlist on and empty). On a mint that gave Sentinel its freeze authority, it can freeze any holder's token account, for as long as it likes (2.2), and hand the freeze authority to any address or give it up (2.3). A multisig is recommended. |
| Mint authority | Trusted at setup | Creates the policy and the meta list (so nobody else can claim a mint's policy first). Can mint to any account; minting does not run the hook. |
| Mint's freeze authority | Trusted | Chosen when the mint is created. If it is Sentinel's freeze address, only Sentinel can freeze and thaw, and only for the policy authority. If it is anyone else (from the start, or after `set_freeze_authority`), Sentinel cannot freeze at all, and that key freezes outside Sentinel's rules and records; a `FreezeAuthorityChanged` event shows when it left Sentinel. |
| Program upgrade authority | Fully trusted | Can replace the program. On devnet it is a single key; on mainnet it must be a multisig, with a verified build. |
| Token-2022 | Trusted | Calls the hook on every transfer, with the accounts resolved from the meta list and with `amount = u64::MAX` for a confidential transfer. Refuses every instruction on a frozen account, and checks that a frozen or thawed account belongs to the mint. |
| Holders, delegates, anyone else | Untrusted | Can send any instruction with any accounts. |

## Invariants

These must hold for every mint whose transfer hook is Sentinel. The integration tests check each
of them; the tests named here are in `tests/`. The model-based fuzz tests in `tests-fuzz/` check
all eleven together, after every step of random sequences of operations (see "How the invariants
are tested" below).

1. **Fail closed.** If the policy or the meta list is missing, every transfer of the mint fails.
   (Anchor cannot load the policy account, or Token-2022 cannot resolve the hook's accounts.)
   (`admin.ts`)
2. **Only the policy authority changes the rules.** `update_policy`, the list instructions,
   `propose_authority`, `cancel_authority_transfer` and `update_extra_account_meta_list` check
   `has_one = authority` against the policy. (`admin.ts`, `sentinel.ts`)
3. **Only the mint authority creates a policy and a meta list**, so a stranger cannot set up
   rules for someone else's mint first, and a stranger cannot stop the mint authority from
   creating them either, for example by funding their addresses first (2.1.1). (`sentinel.ts`,
   `admin.ts`, `setup.ts`)
4. **A handover needs both sides.** The policy authority changes only when the proposed authority
   signs `accept_authority`; until then the old authority can cancel. (`admin.ts`, `sdk.ts`)
5. **Blocklist.** With the blocklist on, no transfer succeeds whose sender, recipient or signing
   authority is blocklisted, on public and confidential transfers alike. (`sentinel.ts`,
   `confidential.ts`, `admin.ts`)
6. **Allowlist.** With the allowlist on, no transfer succeeds to a recipient without an allow
   entry. (`sentinel.ts`, `confidential.ts`)
7. **Limit.** A public transfer above the limit fails. A confidential transfer on a mint with a
   limit fails unless `allow_confidential` is set. (`sentinel.ts`, `confidential.ts`)
8. **Entries cannot be forged.** Allow and block entries are PDAs that only the authority-gated
   instructions create. Token-2022 hands the hook exactly the PDAs the meta list resolves; the
   fifth entry, read from `remaining_accounts`, is checked by content (owner, discriminator,
   mint, wallet) as well.
9. **The hook holds no state.** Calling `transfer_hook` directly, outside a transfer, changes
   nothing, so it needs no check that a transfer is in progress.
10. **Only the policy authority uses the freeze authority, and only through the mint's own freeze
    address.** `freeze_token_account`, `thaw_token_account` and `set_freeze_authority` check
    `has_one = authority` against the policy and sign with the seeds `["freeze-authority", mint]`.
    A mint whose freeze authority is any other address, or none, gets `FreezeAuthorityNotSentinel`
    (6008). Because the address is derived from the mint, Sentinel can sign for no other mint.
    `set_freeze_authority` refuses Sentinel's own address and the default address
    (`InvalidAuthority`, 6007); giving the authority up is an explicit `None`. (`enforcement.ts`,
    `confidential.ts`)
11. **Enforcement is recorded.** Every successful `block_wallet`, `unblock_wallet`,
    `freeze_token_account` and `thaw_token_account` emits exactly one `EnforcementAction`: the mint,
    the wallet (the owner, for a token account), the token account (the default address for a block
    or unblock), the action, the issuer's reason code and case reference, and the authority that
    signed. Every successful `set_freeze_authority` emits exactly one `FreezeAuthorityChanged`: the
    mint, the new freeze authority (or none), the reason and the authority. The plain list
    instructions emit neither. (`enforcement.ts`)

## Known limits

These follow from how Token-2022 and transfer hooks work. They are documented, not bugs.

- **Confidential amounts are invisible to the hook.** No on-chain rule can depend on the amount of
  a confidential transfer. Amounts are watched off-chain with the mint's auditor key, which
  decrypts every confidential transfer (`confidential.ts` shows the auditor reading an amount
  above the limit that the hook could not see).
- **The hook runs on transfers only.** `mint_to`, `burn`, and moving one's own balance between
  public and confidential (`deposit`, `withdraw`) do not call it. The allowlist therefore does not
  stop the mint authority from minting to any account, and a blocklisted wallet can still burn.
  To stop those too, freeze the account (2.2).
- **Freezing needs a freeze authority chosen when the mint is created.** Token-2022 cannot add a
  freeze authority to a mint created without one, so such a mint can never freeze, through Sentinel
  or otherwise. A mint created with the issuer as freeze authority can hand it to Sentinel later
  (Token-2022 `SetAuthority`; the SDK's `setSentinelAsFreezeAuthority`).
- **Handing the freeze authority on is final for Sentinel.** After `set_freeze_authority`, only
  the new holder can hand it back (Token-2022 `SetAuthority`); after giving it up (`None`), nobody
  can freeze the mint ever again. Sentinel cannot check that the new address is the one the issuer
  meant, so a mistyped address loses the freeze power for good. The policy authority (a multisig)
  should check the address before signing. In 2.2 the hand-over to Sentinel was one-way.
- **A freeze covers the token accounts that exist.** A frozen wallet can open a new token account
  of the mint. Blocking the wallet as well stops transfers into that new account, which is what
  the SDK's `blockAndFreezeWallet` does. `freezeWallet` finds a wallet's accounts with an RPC
  query, so it does not see an account created after it ran.
- **Sentinel does not interpret reasons.** `reason_code` is whatever the issuer's own list says
  (the SDK suggests one), and `case_ref` is 32 opaque bytes. The SDK's `caseRef` hashes the case
  number with a salt; the salt must stay secret, or a short case number can be found from its hash
  by trying them all.
- **The allowlist checks the recipient, not the sender.** A wallet that received tokens before it
  was removed from the allowlist (or by `mint_to`) can still send them to allowlisted wallets.
  This lets holders exit; an issuer who wants otherwise also blocklists them.
- **`u64::MAX` means "confidential".** A public transfer of exactly `u64::MAX` base units would be
  read as confidential. It needs a supply of at least `u64::MAX`, so in practice it cannot happen.
- **Mints set up before 2.1** do not check the transfer authority until the policy authority runs
  `update_extra_account_meta_list` once.
- **A self-transfer never reaches the hook.** When the source and destination accounts are the
  same, Token-2022 (v11.1) returns before calling the transfer hook. Nothing moves, so no rule is
  bypassed, but such a transfer succeeds even for a blocklisted owner and leaves no `TransferRefused`
  event. The fuzz tests model this.
- **Setup needs a mint authority that can sign.** The policy and the meta list are created by the
  mint authority. Set Sentinel up before revoking the mint authority (a fixed-supply token), and
  note that an SPL Token multisig account cannot sign for it; a multisig vault program such as
  Squads, which signs through CPI, can.

## Findings of our own review (12 October 2026)

| # | Finding | Severity (our estimate) | Status |
|---|---|---|---|
| 1 | A blocklisted wallet acting as a delegate (or as a permanent delegate) could move a clean holder's tokens to a clean wallet: the blocklist checked the owners of the two token accounts, not the signing authority. Reproduced on a local validator. | Medium | Fixed in 2.1.0: the meta list includes the authority's block entry and the hook refuses with `AuthorityBlocked`. Existing mints run `update_extra_account_meta_list`. Test: `admin.ts`. |
| 2 | The policy authority was a single key with no way to change it. A lost key froze the rules forever; a typo in a future "set authority" would have done the same. | Medium (operational) | Fixed in 2.1.0: two-step handover, multisig-ready. |
| 3 | The meta list could not be changed after creation, so no new rule could reach existing mints. | Low | Fixed in 2.1.0: `update_extra_account_meta_list`. |
| 4 | Refusals left only an error code; nothing recorded policy changes. | Informational | 2.1.0: events for every change and refusal. |
| 5 | Anyone can call `transfer_hook` directly. Harmless while the hook holds no state (invariant 9). A future stateful rule, such as a per-wallet daily limit, must first check that Token-2022 is mid-transfer (the `transferring` flag on the source account). | Informational | Still holds in 2.3; 2.2 and 2.3 add no state to the hook. Recorded as a rule for any stateful rule. |
| 6 | Minting does not run the hook, so the allowlist does not limit who can receive newly minted tokens. | Informational | Documented above. |
| 7 | The devnet program's upgrade authority is a single key. | n/a on devnet | Mainnet: multisig upgrade authority and a verified build, before launch. |
| 8 | A stranger could block a mint's setup for good. `initialize_extra_account_meta_list` created the list with System `CreateAccount`, which refuses an address that already holds lamports, and anyone can send lamports to any address. About 0.0009 SOL sent to a mint's meta-list address before the issuer created the list made the list impossible to create, and every transfer of the mint then failed. Found in our own review on 14 October; reproduced on a local validator, and found again by the fuzz tests on the 2.1.0 build. The policy account was not affected: Anchor's `init` already handles a funded address. | Medium (a permanent denial of service for a mint whose list is created in a separate transaction) | Fixed in 2.1.1: the list is created the way Anchor's `init` does it (top up the rent, allocate, assign) when its address already holds lamports. A second `initialize_extra_account_meta_list` still fails. Tests: `setup.ts`, `tests-fuzz`. On 2.1.0, creating the meta list in the same transaction as the mint avoids it. Mints already set up are not affected. |

## How the invariants are tested

- **Integration tests** (`tests/`, 63 on a local validator with Token-2022 v11.1 and the ZK ElGamal
  Proof Program): each rule, each instruction's authority checks, delegates, the handover, the
  meta-list update, events, setup with funded addresses, freezing and thawing (what a frozen
  account can no longer do, who may freeze, mints whose freeze authority is not Sentinel's),
  handing the freeze authority on and giving it up, the enforcement record, and 12 tests with real confidential transfers where Token-2022 itself calls
  the hook, one of them to a frozen account.
- **Model-based fuzzing** (`tests-fuzz/`, in LiteSVM with the same Token-2022 build). Random
  sequences of every instruction, signed by the right authority or by someone else; freezes and
  thaws with reasons, on mints whose freeze authority is Sentinel's address, the issuer or nobody,
  and on accounts that are not the mint's; the freeze authority handed to Sentinel, and by
  Sentinel to another address or to nobody, including the addresses it must refuse;
  public transfers by owners and by delegates; approvals; direct calls to the hook with public
  amounts, with `u64::MAX` (confidential) and with made-up accounts; strangers funding the
  program's addresses before setup. A plain Rust model of the rules predicts each outcome, down to
  the exact error code, and after every step the test compares the whole state with the model: the
  policy, every entry, a pending handover, balances, delegations, which accounts are frozen, the
  mint's freeze authority, the meta list's bytes and the total supply. It also decodes every
  `EnforcementAction` and `FreezeAuthorityChanged` a step emitted and compares them with the
  model, field by field. CI runs a
  new random set of cases on every push; a failure prints the seed that reproduces it.
- **Is the fuzzing strong enough?** It found finding 8 on the 2.1.0 build. We also broke the
  program on purpose in 39 ways (a dropped authority check, a rule switched off, an off-by-one, a
  freeze recorded with the wrong action or reason), and the fuzz tests catch all 39. They execute
  524 of the 543 lines of `lib.rs` that carry code (96.5%), every line added in 2.2 and 2.3 among
  them except one error exit that cannot be reached; the other 19 are listed with the reason. Both are in `tests-fuzz/README.md`.
- **CI** also runs `cargo clippy -D warnings`, `cargo audit`, a check that the committed IDL matches
  the program, and an in-place upgrade from 2.0.2.

## What we ask an auditor to look at

- Every instruction's account validation: signers, `has_one`, seeds and bumps, `close` targets,
  and the unchecked accounts marked `CHECK`.
- The meta-list seeds (`extra_account_metas`) against what Token-2022 passes to the hook, for
  public transfers, delegated transfers and confidential transfers.
- `update_extra_account_meta_list`: the resize, the rent top-up, and the rewrite of an existing
  list.
- `create_program_account` (2.1.1): creating the meta list at an address that already holds
  lamports.
- The authority handover, including cancel and accept races.
- `SetFrozen` (2.2): the freeze-authority constraint on the mint, the signer seeds of the freeze
  address, and the unchecked `token_account`, which Sentinel passes to Token-2022 and reads only
  for the event.
- `SetFreezeAuthority` (2.3): the same constraint and seeds, the checks on the new address, and the
  `SetAuthority` CPI on the mint.
- Invariants 1–11 above.

The tests run on a local validator with a current Token-2022 and the ZK ElGamal Proof Program
enabled; `anchor test` reproduces them, and CI runs them on every push.
