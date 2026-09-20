# Contributing

Thanks for your interest in Sentinel. This repository holds two pieces that are released together:

- **Program** (`programs/sentinel`) — the Anchor/Token-2022 transfer-hook program
- **TypeScript SDK** (`sdk/`) — `@softseco/sentinel`

## Prerequisites

- **Rust** (stable) with `rustfmt` and `clippy`
- **Solana CLI** ≥ 2.1 (tested on 4.2.2) and `solana-test-validator`
- **Anchor** 0.31.0, installed through `avm`
- **Node ≥ 20** and npm

## Program

```bash
anchor build -- --tools-version v1.57   # see "Build requirements" below
anchor idl build -o sdk/src/idl/sentinel.json -t sdk/src/idl/sentinel.ts
cargo fmt --all --check
cargo clippy -p sentinel --all-targets -- -D warnings
```

### Build requirements

`anchor build` invokes the Solana SBF toolchain. The default platform-tools build (**v1.48**) ships
Cargo 1.84, which cannot parse `edition2024` manifests, so any dependency that has moved to
edition 2024 fails to build. Two things follow:

- Build with **platform-tools v1.57**: `anchor build -- --tools-version v1.57`.
- `Cargo.lock` pins **`blake3 = 1.5.5`**. Later blake3 pulls `cpufeatures 0.3.x`, which is
  edition 2024. Do not bump it without also confirming the toolchain version above.

The `--tools-version` flag is forwarded to the IDL step's `cargo test` invocation, where it is not a
valid argument, so run `anchor idl build` as a separate command (as above) rather than relying on the
IDL that `anchor build` would emit.

### Lints

`programs/sentinel/Cargo.toml` carries a `[lints.rust]` table. Anchor's `#[program]` and
`#[derive(Accounts)]` macros expand to code guarded by cfgs that exist only in the SBF build
(`target_os = "solana"`) or as Anchor's own opt-in features (`custom-heap`, `custom-panic`,
`anchor-debug`), and to a call to the deprecated `AccountInfo::realloc`. On a host-target clippy run
all of these surface as errors under `-D warnings`, and none of them come from this crate.

The cfgs are **declared**, not blanket-allowed, so a genuinely misspelled cfg still fails.
`deprecated = "allow"` is blunter — it is scoped to this crate and should be removed once Anchor's
generated code moves to `AccountInfo::resize`. Until then, check deprecations by eye when touching
the program.

## Tests

```bash
anchor test --skip-build   # 15 integration tests against a local validator
```

`anchor test` deploys `target/deploy/sentinel.so` to a fresh local validator, so run a successful
`anchor build` first; `--skip-build` then reuses that artifact and avoids rebuilding with the default
toolchain.

## SDK

```bash
cd sdk
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsup → dist/
```

The SDK reads the program interface from `sdk/src/idl/sentinel.json` and `sdk/src/idl/sentinel.ts`.
Both are generated — regenerate them with `anchor idl build` (above) whenever the program's
instructions, accounts or errors change, and commit the result in the same change.

## Conventions

- Every source file carries `// SPDX-License-Identifier: Apache-2.0`.
- Program errors are append-only: add new variants at the end of `SentinelError` so existing error
  codes keep their meaning for deployed clients.
- Changes that alter on-chain account layout, instruction arguments or error codes are breaking and
  belong in a major version, with a `CHANGELOG.md` entry naming the migration.
