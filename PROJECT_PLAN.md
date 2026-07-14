# Sentinel — Project Plan

**One-liner:** a programmable compliance engine for Token-2022 tokenized assets (RWA), built on the
Transfer Hook extension. Enforces allowlists, KYC gates, jurisdiction rules, transfer limits, and
lockups on every transfer, on-chain.

**Why it's fundable:** RWA / tokenization + institutional compliance is a heavily funded narrative,
and this is reusable public-good infrastructure (recurring grant potential). It works on **mainnet
today** — no dependency on the ZK ElGamal Proof Program — so it demos live.

## Tech stack (defaults)

- **On-chain program:** Rust + **Anchor** (fast to write, readable for reviewers/auditors).
- **SDK:** TypeScript on **`@solana/kit`** (consistent with the Confidential Transfers SDK).
- **License:** Apache-2.0.
- Separate repo from `confidential-sdk`.

## Milestones

Runway: ~11 weeks to the autumn Colosseum hackathon (est. Sep 28 – Nov 2, 2026), plus the hackathon
window itself. Confirm dates on colosseum.com.

### M0 — Scaffold + gating spike ✅ DONE
- Repo scaffold (Anchor workspace + SDK workspace).
- Hook program: `InitializeExtraAccountMetaList` + `Execute`, enforcing an allowlist.
- Proven end-to-end: transfer to a non-allowlisted account is **blocked**, allowlisted one
  **succeeds** (local validator). *Riskiest part of the project — de-risked.*

### M1 — Core compliance rules ✅ DONE
- `PolicyConfig` account (per mint) toggling active rules + authority-gated updates.
- Rules: **allowlist**, **blocklist** (sender + recipient), **per-transfer limit**.
- 9 passing integration tests, incl. a live policy update. (KYC-attestation gate: deferred to a
  later rule pack.)

### M2 — TypeScript SDK + publish ✅ DONE
- `@softseco/sentinel` (`SentinelClient`): create a compliant mint, manage policy +
  allow/blocklist, hook-aware transfer, and reads (getPolicy / isAllowlisted / isBlocklisted).
- Published to npm as `v0.1.0` — public proof of work; material for a Superteam microgrant.

### M3 — Reference demo (the money shot)
- A compliant tokenized asset + UI/CLI showing: transfer to allowlisted = OK; non-allowlisted =
  blocked; jurisdiction rule blocks; limit exceeded blocks.
- This is the hackathon demo.

### M4 — Polish + launch + submit
- Docs, SECURITY, CHANGELOG, CONTRIBUTING; build-in-public posts.
- Colosseum submission; Superteam microgrant application on the strength of M2.

## Funding touchpoints

- **Early npm publish (M2)** → Superteam microgrant + bounties + proof of work.
- **Weekly build-in-public** (as with the CT SDK) → visibility.
- **Autumn Colosseum** submission (demo from M3) → non-dilutive prizes + accelerator.
- **Solana Foundation grant** later, once there is traction (RWA-compliance infra is fundable).

## Open questions / to validate

- Exact `spl-transfer-hook-interface` + `spl-tlv-account-resolution` versions vs. installed Anchor.
- Account-resolution design for the extra accounts (allowlist entry PDA seeds).
- Whether to mirror the SDK in Rust (as with the CT project) — decide after M2.
