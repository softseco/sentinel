# Sentinel threat model

Version 2.1.0, 12 October 2026. Written by the author as part of a self-review. Sentinel has not
been independently audited; this document is meant to make that audit faster and cheaper.

## Scope

The on-chain program in `programs/sentinel/src/lib.rs`: one file, about 710 lines of Rust without
blank lines and comments, built with Anchor 0.31.1. Thirteen instructions: `initialize_policy`,
`update_policy`, `initialize_extra_account_meta_list`, `update_extra_account_meta_list`,
`add_to_allowlist`, `remove_from_allowlist`, `add_to_blocklist`, `remove_from_blocklist`,
`propose_authority`, `cancel_authority_transfer`, `accept_authority`, `transfer_hook`, and the
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

The state that carries these rules: one `PolicyConfig` per mint, one `AllowEntry` or `BlockEntry`
per listed wallet, the mint's `ExtraAccountMetaList`, and a `PendingAuthority` while a handover is
in progress. All are PDAs of the program, seeded by the mint.

## Who is trusted

| Actor | Trust | What it can do |
|---|---|---|
| Policy authority | Fully trusted for its mint | Change the rules and the lists, hand the policy over, rewrite the meta list. It can also stop every transfer of the mint (for example, allowlist on and empty). A multisig is recommended. |
| Mint authority | Trusted at setup | Creates the policy and the meta list (so nobody else can claim a mint's policy first). Can mint to any account; minting does not run the hook. |
| Program upgrade authority | Fully trusted | Can replace the program. On devnet it is a single key; on mainnet it must be a multisig, with a verified build. |
| Token-2022 | Trusted | Calls the hook on every transfer, with the accounts resolved from the meta list and with `amount = u64::MAX` for a confidential transfer. |
| Holders, delegates, anyone else | Untrusted | Can send any instruction with any accounts. |

## Invariants

These must hold for every mint whose transfer hook is Sentinel. The integration tests check each
of them; the tests named here are in `tests/`.

1. **Fail closed.** If the policy or the meta list is missing, every transfer of the mint fails.
   (Anchor cannot load the policy account, or Token-2022 cannot resolve the hook's accounts.)
   (`admin.ts`)
2. **Only the policy authority changes the rules.** `update_policy`, the list instructions,
   `propose_authority`, `cancel_authority_transfer` and `update_extra_account_meta_list` check
   `has_one = authority` against the policy. (`admin.ts`, `sentinel.ts`)
3. **Only the mint authority creates a policy and a meta list**, so a stranger cannot set up
   rules for someone else's mint first. (`sentinel.ts`, `admin.ts`)
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

## Known limits

These follow from how Token-2022 and transfer hooks work. They are documented, not bugs.

- **Confidential amounts are invisible to the hook.** No on-chain rule can depend on the amount of
  a confidential transfer. Amounts are watched off-chain with the mint's auditor key, which
  decrypts every confidential transfer (`confidential.ts` shows the auditor reading an amount
  above the limit that the hook could not see).
- **The hook runs on transfers only.** `mint_to`, `burn`, and moving one's own balance between
  public and confidential (`deposit`, `withdraw`) do not call it. The allowlist therefore does not
  stop the mint authority from minting to any account, and a blocklisted wallet can still burn.
  Freezing a balance is a job for Token-2022's freeze authority, not for Sentinel.
- **The allowlist checks the recipient, not the sender.** A wallet that received tokens before it
  was removed from the allowlist (or by `mint_to`) can still send them to allowlisted wallets.
  This lets holders exit; an issuer who wants otherwise also blocklists them.
- **`u64::MAX` means "confidential".** A public transfer of exactly `u64::MAX` base units would be
  read as confidential. It needs a supply of at least `u64::MAX`, so in practice it cannot happen.
- **Mints set up before 2.1** do not check the transfer authority until the policy authority runs
  `update_extra_account_meta_list` once.

## Findings of our own review (12 October 2026)

| # | Finding | Severity (our estimate) | Status |
|---|---|---|---|
| 1 | A blocklisted wallet acting as a delegate (or as a permanent delegate) could move a clean holder's tokens to a clean wallet: the blocklist checked the owners of the two token accounts, not the signing authority. Reproduced on a local validator. | Medium | Fixed in 2.1.0: the meta list includes the authority's block entry and the hook refuses with `AuthorityBlocked`. Existing mints run `update_extra_account_meta_list`. Test: `admin.ts`. |
| 2 | The policy authority was a single key with no way to change it. A lost key froze the rules forever; a typo in a future "set authority" would have done the same. | Medium (operational) | Fixed in 2.1.0: two-step handover, multisig-ready. |
| 3 | The meta list could not be changed after creation, so no new rule could reach existing mints. | Low | Fixed in 2.1.0: `update_extra_account_meta_list`. |
| 4 | Refusals left only an error code; nothing recorded policy changes. | Informational | 2.1.0: events for every change and refusal. |
| 5 | Anyone can call `transfer_hook` directly. Harmless while the hook holds no state (invariant 9). A future stateful rule, such as a per-wallet daily limit, must first check that Token-2022 is mid-transfer (the `transferring` flag on the source account). | Informational | Recorded as a rule for 2.2. |
| 6 | Minting does not run the hook, so the allowlist does not limit who can receive newly minted tokens. | Informational | Documented above. |
| 7 | The devnet program's upgrade authority is a single key. | n/a on devnet | Mainnet: multisig upgrade authority and a verified build, before launch. |

## What we ask an auditor to look at

- Every instruction's account validation: signers, `has_one`, seeds and bumps, `close` targets,
  and the unchecked accounts marked `CHECK`.
- The meta-list seeds (`extra_account_metas`) against what Token-2022 passes to the hook, for
  public transfers, delegated transfers and confidential transfers.
- `update_extra_account_meta_list`: the resize, the rent top-up, and the rewrite of an existing
  list.
- The authority handover, including cancel and accept races.
- Invariants 1–9 above.

The tests run on a local validator with a current Token-2022 and the ZK ElGamal Proof Program
enabled; `anchor test` reproduces them, and CI runs them on every push.
