# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The on-chain program and the
`@softseco/sentinel` SDK are versioned together.

## [1.0.0] - 2026-07-14

First stable release of Sentinel — programmable compliance for Token-2022 tokenized assets.

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

[1.0.0]: https://github.com/softseco/sentinel/releases/tag/v1.0.0
