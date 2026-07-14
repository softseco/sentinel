# Security Policy

Sentinel is security-sensitive, on-chain compliance software (a Token-2022 transfer hook that
gates asset transfers).

> **Maturity:** `v1.0.0`, self-audited, validated against a local validator. **Not independently
> audited and not production-proven.** Review carefully before any mainnet use.

## Supported versions

| Version | Supported |
|---|---|
| `1.x`   | ✅ |
| `< 1.0` | ❌ |

## Reporting a vulnerability

Please do **not** open a public issue, pull request, or social post for security reports. Instead:

1. **GitHub private vulnerability reporting** (preferred) — on the repo, **Security** tab →
   **Report a vulnerability**.
2. **Email** — hello@softseco.com.

Please include the impact, reproduction steps / PoC, affected version(s), and any suggested fix.
We aim to acknowledge within **72 hours**.

## Self-audit

`v1.0.0` shipped after a self-audit that fixed an access-control issue on allowlist/blocklist
management and a policy-authority squatting issue (see [CHANGELOG.md](./CHANGELOG.md)). A
self-audit is **not** a substitute for an independent audit.
