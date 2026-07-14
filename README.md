# Sentinel

**Programmable compliance for Token-2022 tokenized assets — built on Transfer Hooks.**

[![npm (SDK)](https://img.shields.io/npm/v/@softseco/sentinel.svg?label=%40softseco%2Fsentinel)](https://www.npmjs.com/package/@softseco/sentinel)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

Sentinel attaches compliance rules to a Token-2022 mint so **every transfer is checked on-chain**:
an allowlist, a blocklist (sender *and* recipient), and a per-transfer limit — all toggled by a
per-mint policy the issuer controls. Regulated and real-world-asset (RWA) tokens can enforce *who*
may hold and move them, without giving up composability.

> **Status: `v1.0.0` — stable API, self-audited, validated on a local validator (not independently audited).** Built by Softseco.

## Why

Token-2022's **Transfer Hook** extension runs a program on every transfer. Sentinel turns that hook
into a reusable, configurable **compliance engine**, so issuers don't have to write and audit their
own transfer-gating program. Set a policy once; Sentinel enforces it on every move of the asset.

## What's here

- **On-chain program** (Rust / Anchor) — the transfer hook + policy, allowlist, blocklist, limit.
  9 passing integration tests.
- **TypeScript SDK** — [`@softseco/sentinel`](https://www.npmjs.com/package/@softseco/sentinel):
  create a compliant mint, manage the policy and entries, hook-aware transfers, and reads.
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

## Demo

A compliant "ACME" security token, gated live:

```
Terminal 1:  anchor localnet          # validator + deployed program
Terminal 2:  cd sdk && npm run demo
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
```

## Status

**v1.0.0** — program + SDK + demo, 11 integration tests, self-audited before release
(see [CHANGELOG.md](./CHANGELOG.md) · [SECURITY.md](./SECURITY.md)). Pre-alpha maturity:
validated on a local validator, not independently audited. See [PROJECT_PLAN.md](./PROJECT_PLAN.md).

## Local development

```bash
anchor build && anchor test     # program + integration tests
cd sdk && npm install && npm run build
```

Requires the Anchor toolchain, Solana CLI, and Node ≥ 20.

## License

Apache-2.0. See [LICENSE](./LICENSE).
