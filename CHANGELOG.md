# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The on-chain program and the
`@softseco/sentinel` SDK are versioned together.

## [Unreleased]

_Nothing yet._

## [2.1.0] - 2026-10-12

Not deployed yet: the devnet program at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD` is the 2.0.1
build until it is upgraded. No breaking changes: `PolicyConfig`, the entry accounts, every existing
instruction and every existing error code are unchanged.

### Fixed
- **A blocklisted wallet could move tokens as a delegate.** The blocklist checked the owners of
  the source and destination accounts, not the authority signing the transfer. A blocked wallet
  that a clean holder had approved as delegate (or a blocked permanent delegate) could send that
  holder's tokens to any clean wallet. The hook now also refuses when the transfer authority is
  blocklisted (`AuthorityBlocked`, 6006). Found in our own review, on devnet, before any mainnet
  use.

### Added
- `update_extra_account_meta_list`: rewrites a mint's `ExtraAccountMetaList` to the current list
  and grows the account if needed (the policy authority signs and pays the extra rent). The list
  gains a fifth entry, the transfer authority's blocklist entry.
- Two-step handover of the policy authority: `propose_authority`, `accept_authority` (signed by
  the new authority) and `cancel_authority_transfer`. The proposal lives in its own PDA
  (`["pending-authority", mint]`), so nothing changes until the new authority signs, and a
  mistyped address cannot lock a policy. The authority can be a multisig vault such as Squads.
- Events for every policy change and every refusal: `PolicyInitialized`, `PolicyUpdated`,
  `ListEntryAdded`, `ListEntryRemoved`, `MetaListUpdated`, `AuthorityTransferProposed`,
  `AuthorityTransferCancelled`, `AuthorityTransferred`, and `TransferRefused` (mint, both owners,
  the transfer authority, whether the transfer was confidential, and the error code). A refusal
  fails the transaction, but its logs, and the event in them, stay readable.
- Errors `AuthorityBlocked` (6006) and `InvalidAuthority` (6007), appended.
- SDK: instruction builders for every authority-gated instruction with the authority as a
  parameter (`updatePolicyInstruction`, `listInstruction`, `proposeAuthorityInstruction`,
  `acceptAuthorityInstruction`, `cancelAuthorityTransferInstruction`,
  `updateExtraAccountMetaListInstruction`), for authorities that sign elsewhere, such as a
  multisig. `proposeAuthority`, `acceptAuthority`, `cancelAuthorityTransfer`,
  `getPendingAuthority` and `updateExtraAccountMetaList`. Batch list updates
  (`addToAllowlistBatch`, `addToBlocklistBatch` and the `remove` pair), eight changes per
  transaction. `parseEvents` and `getEvents` decode the events above, including from a failed
  transaction's logs. `pendingAuthorityPda`.
- Integration tests with real Token-2022 confidential transfers (`tests/confidential.ts`). The
  sender's proofs go through the ZK ElGamal Proof Program and Token-2022 calls Sentinel as the
  hook, so the rules are checked on the path a real confidential transfer takes: the limit refuses
  confidential transfers until the issuer sets `allow_confidential`, the blocklist stops a blocked
  sender or recipient, the allowlist applies, and the mint's auditor can still read the amounts
  the hook could not see. Until now the confidential branch was tested by calling the hook
  directly with `u64::MAX`.
- Tests for delegates, the meta-list update, events and the authority handover
  (`tests/admin.ts`), and for the SDK (`tests/sdk.ts`). The suite is 44 tests.
- `scripts/upgrade-check.sh` and `tests-upgrade/`: build 2.0.2 and this version, set a mint up
  under 2.0.2 on a local validator, upgrade in place, and check that the mint keeps working and
  that `update_extra_account_meta_list` turns the delegate check on. CI runs it.
- `docs/threat-model.md`: what Sentinel protects, who is trusted, the invariants, known limits
  and the findings of our own review.
- CI builds the program and runs the whole suite on a local validator, checks that the committed
  IDL matches the program, and runs `cargo audit`.

### Upgrading from 2.0.x
- Upgrade the program in place; existing policies, entries and meta lists keep working.
- For each existing mint, the policy authority calls `update_extra_account_meta_list` once
  (SDK: `client.updateExtraAccountMetaList(mint)`). Until then the hook does not receive the
  transfer authority's entry and the delegate check is skipped for that mint. Mints whose meta
  list is created by 2.1 have it from the start.
- Callers that build transfer instructions by hand must resolve the meta list's accounts as
  usual (`@solana/spl-token`'s `createTransferCheckedWithTransferHookInstruction` and
  `@softseco/confidential-transfers` do); there is no fixed account list to update.

## [2.0.2] - 2026-09-28

Documentation and packaging only. The program code is unchanged and was not redeployed: the devnet
program at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD` is the 2.0.1 build.

### Changed
- The README and the SDK README (the npm page) describe the current state: stable API,
  self-audited, deployed on devnet, not independently audited. Both still said "pre-alpha,
  validated on a local validator" in places.
- `PROJECT_PLAN.md`, an early internal planning note, is removed from the repository.
- The IDL metadata and `Cargo.lock` carry the release version; they still said 2.0.0.

### Added
- npm package metadata: keywords, homepage, issue tracker and `engines` (Node ≥ 20).

## [2.0.1] - 2026-09-22

### Changed
- **New program id: `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`.** The keypair behind `4Lr94hphpGHq2VY6CRC5Yxq6k3gs9nSSzsh479hVU1Xw` came from a local build, was never deployed
  anywhere, and no longer exists, so the program was rebuilt under a fresh keypair. `declare_id!`,
  `Anchor.toml` and the SDK's bundled IDL all carry the new id. Nothing on chain referenced the old one.

### Added
- **First deployment — Solana devnet.** The program is live at the id above, with the upgrade authority
  held by Softseco. Program behaviour is unchanged from 2.0.0.

## [2.0.0] - 2026-09-20

### Fixed
- **A policy with a transfer limit rejected every confidential transfer.** Token-2022 invokes a
  transfer hook for a confidential transfer with `amount = u64::MAX`, because the real amount is
  encrypted. The limit rule compared that sentinel against `max_transfer_amount` and failed, so a
  mint that combined Token-2022 confidential transfers with any Sentinel limit could not transfer
  at all. Mints with no limit set (`max_transfer_amount == 0`) were unaffected. Found in review,
  before any mainnet use.

### Changed
- **BREAKING — `PolicyConfig` gained `allow_confidential`,** and `initialize_policy` /
  `update_policy` take it as a fourth argument. An amount limit cannot be enforced on an encrypted
  amount, so the hook now refuses a confidential transfer on a limited mint unless the policy sets
  this flag — the issuer accepting, explicitly, that the limit does not apply to those transfers.
  Silently skipping the limit instead would leave a policy that reads as enforced but is not.
- The allowlist and blocklist rules are unchanged: they work on addresses, which stay public, so
  they apply to confidential transfers exactly as they do to public ones.
- The account layout changed, so existing `PolicyConfig` accounts must be recreated.

### Added
- `SentinelError::ConfidentialAmountNotEnforceable`, appended so the existing error codes keep
  their numbers.
- `CONFIDENTIAL_TRANSFER_AMOUNT` — the `u64::MAX` sentinel, named rather than written inline.
- SDK: `allowConfidential` on `PolicyView`, and an optional `allowConfidential` on
  `initializePolicy` / `updatePolicy` (default `false`, which preserves the stricter behaviour).
- **Four integration tests for the confidential branch** (suite is now 15): with a limit set and
  `allow_confidential = false` the hook fails with `ConfidentialAmountNotEnforceable` (asserting
  the name *and* code 6005, so the number stays stable for deployed clients); with the flag set it
  passes; with no limit it passes either way; and the allowlist still rejects a non-allowlisted
  recipient while letting an allowlisted one through — confidentiality hides the amount, not the
  parties.
- `LICENSE` (Apache-2.0), `NOTICE`, `CONTRIBUTING.md` and a CI workflow (`cargo fmt`, `clippy`,
  test typecheck, SDK typecheck + build). `sdk/` carries its own `LICENSE`/`NOTICE` so the
  published npm package includes them.
- A `[lints.rust]` table on the program crate declaring the cfgs Anchor's macros expand to
  (`target_os = "solana"`, `custom-heap`, `custom-panic`, `anchor-debug`) so `clippy -D warnings`
  passes without blanket-allowing unknown cfgs. `deprecated` is allowed for the same reason —
  Anchor 0.31.1's generated code calls `AccountInfo::realloc`; nothing in this crate does.

### Verified
- Builds clean with Anchor 0.31.0 and Solana platform-tools v1.57. The regenerated IDL carries the
  fourth `allow_confidential` argument on `initialize_policy` and `update_policy`, the new
  `PolicyConfig` field, and error 6005 appended after the existing 6000–6004.
- The IDL is committed at `sdk/src/idl/sentinel.json` / `.ts`, so the SDK and CI build from the
  same interface the program exposes. `@softseco/sentinel` typechecks and builds against it.
- `anchor test --skip-build`: **15 passing**, including all four confidential-branch cases.
  `cargo fmt --all --check` is clean.

### Build requirements
- Solana platform-tools **v1.57 or newer**: `anchor build -- --tools-version v1.57`. Older
  tool-chains ship Cargo 1.84, which cannot parse dependencies that have moved to Rust edition
  2024. `Cargo.lock` pins `blake3` to 1.5.5 for the same reason; that pin can be relaxed once
  v1.57 is the baseline everywhere.

### Known limits
- The confidential-branch tests call `transfer_hook` directly with `u64::MAX` rather than issuing a
  real confidential transfer, which would additionally need Token-2022's confidential-transfer
  extension and the ZK ElGamal Proof program on the validator. They cover the program's own
  decision for that amount — the part that was wrong — not Token-2022's end of the interface.
- Not independently audited. Review before production use.

## [1.0.0] - 2026-07-14

First stable release of Sentinel — programmable compliance for Token-2022 tokenized assets.

The SDK at this version was not published to npm: `@softseco/sentinel` went from 0.1.0 to 2.0.0.

### Added
- **Compliance program** (Anchor): per-mint `PolicyConfig` toggling an **allowlist**, a **blocklist**
  (sender + recipient), and a **per-transfer limit**, enforced on every transfer via the Token-2022
  Transfer Hook. Authority-gated policy updates.
- **TypeScript SDK** `@softseco/sentinel`: compliant mint creation, policy + allow/blocklist
  management, hook-aware transfers, and reads (`getPolicy`, `isAllowlisted`, `isBlocklisted`).
- Runnable demo (`sdk/examples/compliant-asset-demo.ts`) and **11 integration tests**.

### Security
Self-audited before release. Fixed:
- **High** — allowlist/blocklist writes were not restricted to the policy authority, allowing anyone
  to allowlist wallets (compliance bypass) or blocklist wallets (griefing). Now gated by
  `has_one = authority`, with a negative test.
- **Medium** — anyone could initialize a mint's policy and become its authority (policy-authority
  squatting). Policy and hook-account setup are now bound to the **mint authority**, with a negative
  test.
- **Low** — the extra-account-meta-list initializer is now bound to the mint authority.

Informational (no exploit): the transfer hook relies on Token-2022's deterministic account
resolution for the allow/block entries; documented in-code. Not independently audited — review
before production use.

[Unreleased]: https://github.com/softseco/sentinel/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/softseco/sentinel/releases/tag/v2.1.0
[2.0.2]: https://github.com/softseco/sentinel/releases/tag/v2.0.2
[2.0.1]: https://github.com/softseco/sentinel/releases/tag/v2.0.1
[2.0.0]: https://github.com/softseco/sentinel/releases/tag/v2.0.0
[1.0.0]: https://github.com/softseco/sentinel/releases/tag/v1.0.0
