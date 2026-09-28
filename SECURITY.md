# Security Policy

Sentinel is security-sensitive, on-chain compliance software (a Token-2022 transfer hook that
gates asset transfers).

> **Maturity:** `v2.0.2`, self-audited, validated against a local validator and deployed on devnet. **Not independently
> audited and not production-proven.** Review carefully before any mainnet use.

## Supported versions

| Version | Supported |
|---|---|
| `2.x`   | ✅ |
| `< 2.0` | ❌ |

`2.0.0` changed the `PolicyConfig` account layout and the `initialize_policy` / `update_policy`
signatures. Mints still running a `1.x` policy should migrate: see [CHANGELOG.md](./CHANGELOG.md).

## Reporting a vulnerability

Please do **not** open a public issue, pull request, or social post for security reports. Instead:

1. **GitHub private vulnerability reporting** (preferred) — on the repo, **Security** tab →
   **Report a vulnerability**.
2. **Email** — hello@softseco.com.

Please include the impact, reproduction steps / PoC, affected version(s), and any suggested fix.
We aim to acknowledge within **72 hours**.

## Self-audit

`v1.0.0` shipped after a self-audit that fixed an access-control issue on allowlist/blocklist
management and a policy-authority squatting issue (see [CHANGELOG.md](./CHANGELOG.md)).

`v2.0.0` fixed a correctness issue found in review, before any mainnet use: the per-transfer limit
compared Token-2022's confidential-transfer sentinel (`u64::MAX`) against `max_transfer_amount`,
so a limited mint could not perform confidential transfers at all. The hook now refuses such a
transfer explicitly unless the policy sets `allow_confidential`, rather than either failing
opaquely or skipping a limit that the policy still advertises as enforced.

A self-audit is **not** a substitute for an independent audit.
