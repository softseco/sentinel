# Sentinel

**Programmable compliance for Token-2022 tokenized assets — built on Transfer Hooks.**

[![npm (SDK)](https://img.shields.io/npm/v/@softseco/sentinel.svg?label=%40softseco%2Fsentinel)](https://www.npmjs.com/package/@softseco/sentinel)
[![CI](https://github.com/softseco/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/softseco/sentinel/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

Sentinel attaches compliance rules to a Token-2022 mint so **every transfer is checked on-chain**:
an allowlist, a blocklist (sender, recipient, and a delegate moving someone else's tokens), and a
per-transfer limit — all toggled by a per-mint policy the issuer controls. Regulated and real-world-asset (RWA) tokens can enforce *who*
may hold and move them, without giving up composability.

**Freezing (2.2).** A hook can only refuse transfers. When a wallet must be stopped completely
(no transfers in or out, no burns, no approvals, nothing confidential either), the issuer freezes
its token accounts through Sentinel, which holds the mint's freeze authority. Every block, unblock,
freeze and thaw can carry the issuer's reason code and a case reference, recorded on-chain in an
`EnforcementAction` event, so the record of what was done and why does not depend on anyone's
spreadsheet. The freeze authority can also leave Sentinel again (2.3), to another address or to
no one, and that move is recorded the same way.

**Confidential transfers.** Token-2022 hides the amount of a confidential transfer from the hook,
which means an amount limit cannot be enforced on one — it is unenforceable, not satisfied. So a
mint that sets `maxTransferAmount` refuses confidential transfers unless its policy also sets
`allowConfidential`, which is the issuer accepting in the open that the limit does not reach them.
The allowlist and blocklist work on addresses, which stay public, so they apply to confidential
transfers exactly as they do to public ones.

> **Status: `v2.3.0` — stable API, self-audited, running on Solana devnet (not independently audited).** Built by Softseco.
>
> **Devnet program:** [`5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`](https://explorer.solana.com/address/5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD?cluster=devnet)

## Why

Token-2022's **Transfer Hook** extension runs a program on every transfer. Sentinel turns that hook
into a reusable, configurable **compliance engine**, so issuers don't have to write and audit their
own transfer-gating program. Set a policy once; Sentinel enforces it on every move of the asset.

## What's here

- **On-chain program** (Rust / Anchor) — the transfer hook + policy, allowlist, blocklist, limit;
  freezing and thawing token accounts, with the reason recorded; a two-step handover of the policy
  authority (to a multisig, for example); an event for every policy change, every enforcement
  action and every refused transfer. 63 integration tests on a local validator, 12 of them with
  real Token-2022 confidential transfers, where Token-2022 itself calls the hook. CI runs all of
  them on every push.
- **Model-based fuzzing** — [`tests-fuzz/`](./tests-fuzz): random sequences of every instruction,
  transfer, approval, freeze and thaw in LiteSVM, each outcome, the whole state and every
  enforcement event checked against a model of the rules after every step. CI runs a new random
  set on every push.
- **Threat model** — [`docs/threat-model.md`](./docs/threat-model.md): what Sentinel protects, who
  is trusted, the invariants it keeps, and its known limits.
- **TypeScript SDK** — [`@softseco/sentinel`](https://www.npmjs.com/package/@softseco/sentinel):
  create a compliant mint, manage the policy and entries, freeze and thaw, hook-aware transfers,
  and reads.
- **Runnable demo** — [`sdk/examples/compliant-asset-demo.ts`](./sdk/examples/compliant-asset-demo.ts).

## Quickstart (SDK)

```bash
npm install @softseco/sentinel
```

```ts
import { SentinelClient } from "@softseco/sentinel";

const sentinel = new SentinelClient(provider); // AnchorProvider

await sentinel.createCompliantMint({ mint, decimals: 0 });
await sentinel.initializePolicy({ mint: mint.publicKey, allowlist: true, blocklist: true, maxTransferAmount: 1000n });
await sentinel.initializeExtraAccountMetaList(mint.publicKey);
await sentinel.addToAllowlist(mint.publicKey, investor);
await sentinel.transfer({ mint: mint.publicKey, destinationOwner: investor, amount: 100n, decimals: 0 });
```

To freeze, create the mint with Sentinel as its freeze authority (Token-2022 cannot add one later):

```ts
import { ENFORCEMENT_REASONS, caseRef } from "@softseco/sentinel";

await sentinel.createCompliantMint({ mint, decimals: 0, freezeAuthority: "sentinel" });
// ... policy and meta list as above ...
const why = { reasonCode: ENFORCEMENT_REASONS.courtOrder, caseRef: caseRef("CASE-2026-0042", secretSalt) };
await sentinel.blockAndFreezeWallet(mint.publicKey, suspect, why);
```

## Demo

A compliant "ACME" security token, gated live:

```
Terminal 1:  anchor localnet          # validator + deployed program
Terminal 2:  cd sdk && npm install && npm run demo
```

```
✅ Issuer → Alice    500   (allowlisted, within limit)
⛔ Issuer → Carol    500   → recipient not allowlisted
⛔ Issuer → Alice   2000   → exceeds transfer limit
⛔ Issuer → Mallory  100   → recipient sanctioned
✅ Issuer → Alice   2000   (now within the new limit, after a policy update)
```

## Repository layout

```
programs/sentinel/   on-chain Anchor program
sdk/                 @softseco/sentinel TypeScript SDK (+ examples/)
tests/               integration tests (anchor test)
tests-fuzz/          model-based fuzzing in LiteSVM (cargo test)
docs/                threat model
```

## Status

**v2.3.0** — program + SDK + demo, 63 integration tests and model-based fuzzing, self-audited
before release (see [CHANGELOG.md](./CHANGELOG.md) · [SECURITY.md](./SECURITY.md) ·
[threat model](./docs/threat-model.md)). Not independently audited. 2.2 added freezing through
Sentinel and the enforcement record; 2.3 lets the freeze authority leave Sentinel again. Nothing
existing changes. The devnet program runs 2.1.0
since 12 October 2026; mints set up before 2.1 call `update_extra_account_meta_list`
once to get the delegate check. Breaking since 1.0.0: `PolicyConfig` gained `allow_confidential` and existing policy
accounts must be recreated. A confidential transfer through a Sentinel mint, with the blocklist
enforced on the same transfer, runs end-to-end on devnet in
[paper-devnet](https://github.com/softseco/paper-devnet).

## Local development

```bash
anchor build -- --tools-version v1.57                                   # program
anchor idl build -o sdk/src/idl/sentinel.json -t sdk/src/idl/sentinel.ts  # IDL
anchor test --skip-build                                                # 63 integration tests
cd tests-fuzz && cargo test --test model -- --nocapture                 # fuzzing (needs the build)
cd sdk && npm install && npm run build                                  # SDK
```

Requires the Anchor toolchain (0.31.0), Solana CLI, and Node ≥ 20. The `--tools-version` flag is
needed because the default platform-tools build cannot parse Rust edition-2024 dependencies, and
the IDL step is run separately because that flag is not valid there —
see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
