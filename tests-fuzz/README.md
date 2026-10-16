<!-- SPDX-License-Identifier: Apache-2.0 -->
# Model-based fuzzing of Sentinel

The integration tests in `tests/` check one situation at a time. These tests throw long random
sequences of operations at the program instead, and check every step against a model of the
rules written in plain Rust.

They run the built program (`target/deploy/sentinel.so`) in [LiteSVM](https://github.com/LiteSVM/litesvm),
next to the same Token-2022 build the integration tests use (`tests/fixtures/spl_token_2022.so`,
v11.1). This is a separate Cargo project: it loads the program file and does not depend on the
program crate.

## Run

```bash
anchor build                      # or: cargo build-sbf --manifest-path programs/sentinel/Cargo.toml
cd tests-fuzz
cargo test --test model -- --nocapture
```

| Variable | Default | |
|---|---|---|
| `FUZZ_CASES` | 64 | Independent cases (a fresh mint each) |
| `FUZZ_STEPS` | 60 | Random operations per case, after setup |
| `FUZZ_SEED` | fixed | Seed of the whole run; CI uses its run id, so every push tries new cases |
| `SENTINEL_SO`, `TOKEN_2022_SO` | the paths above | Programs to load |

The first build compiles the Solana runtime and takes several minutes. A default run then takes
about 8 seconds and makes about 4,000 operations.

A failure prints the seed, the case, the step, what the model expected, what happened (with the
program logs) and the operations that led there. `FUZZ_SEED=<seed>` reproduces it exactly.

## What a case does

Setup: a mint with Sentinel as its transfer hook, five wallets with token accounts and random
balances. The mint's freeze authority is Sentinel's freeze address in most cases, the issuer in
some, and nobody in a few. Most cases then create the policy (random rules) and the meta list;
some start without one or both, and some have a stranger fund the policy or meta-list address
first. A second mint provides a token account that is not the first mint's.

Then random operations, each picked from:

- every Sentinel instruction, signed by the current authority, the issuer, a pending authority, a
  random wallet, or an address nobody holds a key for;
- blocks and unblocks with a reason (`block_wallet`, `unblock_wallet`) as well as without;
- freezes and thaws with random reason codes and case references, mostly of the mint's token
  accounts, sometimes of the other mint's account, the policy account or the mint itself, and
  sometimes of an account already in that state;
- whoever holds the mint's freeze authority (or someone else) handing it to Sentinel, and Sentinel
  handing it on with `set_freeze_authority` (2.3): to the issuer, a wallet, an address nobody
  holds, or nobody at all, and to the addresses it must refuse (its own and the default address);
- public transfers through Token-2022, by the owner or a delegate, including self-transfers,
  zero amounts, amounts at and above the limit, and more than the balance;
- approvals of delegates, which a frozen account refuses;
- `Execute` sent straight to the hook with the accounts Token-2022 would pass, with a public
  amount or `u64::MAX` (what Token-2022 passes for a confidential transfer), and with made-up
  accounts;
- strangers funding the policy or meta-list address before it exists.

## What is checked after every step

- **The outcome.** The model predicts success or failure, and for each Sentinel rule the exact
  error code (`RecipientNotAllowlisted`, `TransferExceedsLimit`, `SenderBlocked`,
  `RecipientBlocked`, `Unauthorized`, `ConfidentialAmountNotEnforceable`, `AuthorityBlocked`,
  `InvalidAuthority`, `FreezeAuthorityNotSentinel`), in the order the program checks them, and
  Token-2022's `AccountFrozen` and `InvalidState` where those come first.
- **The whole state.** The policy (mint, authority, rules), every allow and block entry, a pending
  handover, every balance, delegation and frozen flag, the mint's freeze authority, the meta list's
  bytes (which only `initialize` and `update_extra_account_meta_list` may change), and the total
  supply.
- **The record.** Every `EnforcementAction` and `FreezeAuthorityChanged` event a successful step
  emitted, decoded from its logs and compared field by field with what the model expects; a step
  that should emit none must emit none.

The model is the threat model's invariants written as code (`docs/threat-model.md`): fail closed,
only the policy authority changes the rules, only the mint authority sets up and nobody can block
that, a handover needs both sides, blocklist, allowlist, limit and confidential amounts, entries
cannot be forged, the hook holds no state, only the policy authority freezes and only through the
mint's own freeze address, and enforcement is recorded.

It also models the Token-2022 behaviour that decides outcomes here: a frozen source is refused
first; a transfer whose source and destination are the same account then returns before the hook
is called (a frozen account still refuses it); a frozen destination is refused after that.

## Does it catch bugs?

It found finding 8 of the threat model on the 2.1.0 build: a stranger funding a mint's meta-list
address first blocked the mint's setup for good.

`mutants.py` breaks the program on purpose, one small change at a time (a dropped authority check,
a rule switched off, an off-by-one), builds each broken program and runs these tests against it:

```bash
python3 tests-fuzz/mutants.py          # from the repository root; about 10 s per mutant
```

With the default run (64 cases, 16 October 2026), all 39 are caught:

| Mutant | What it breaks | Result |
|---|---|---|
| `limit-off-by-one` | the limit refuses a transfer equal to it | caught |
| `limit-ignored` | the limit is never checked | caught |
| `confidential-limit-ignored` | confidential transfers pass a limited mint without `allow_confidential` | caught |
| `sender-blocklist-off` | a blocklisted sender is not refused | caught |
| `recipient-blocklist-off` | a blocklisted recipient is not refused | caught |
| `authority-blocklist-off` | a blocklisted delegate is not refused | caught |
| `blocklist-flag-ignored` | the blocklist applies while switched off | caught |
| `allowlist-off` | the allowlist is never checked | caught |
| `any-block-entry-blocks` | any block entry passed as the authority's blocks the transfer | caught |
| `rules-in-wrong-order` | sender and recipient checks swapped (wrong error code) | caught |
| `update-policy-anyone` | anyone can change the rules | caught |
| `add-allow-anyone` | anyone can allowlist | caught |
| `remove-allow-anyone` | anyone can remove an allow entry | caught |
| `add-block-anyone` | anyone can blocklist | caught |
| `remove-block-anyone` | anyone can remove a block entry | caught |
| `update-meta-list-anyone` | anyone can rewrite the meta list | caught |
| `propose-anyone` | anyone can propose a new authority | caught |
| `cancel-anyone` | anyone can cancel a handover | caught |
| `accept-anyone` | anyone can accept a handover | caught |
| `accept-wrong-rent-receiver` | the proposal's rent can go to someone other than the old authority | caught |
| `propose-to-self` | the authority can propose itself | caught |
| `init-policy-anyone` | anyone can create the policy | caught |
| `init-meta-list-anyone` | anyone can create the meta list | caught |
| `update-policy-keeps-flag` | `update_policy` forgets to store the blocklist flag | caught |
| `accept-keeps-old-authority` | `accept_authority` does not change the authority | caught |
| `funded-address-blocks-setup` | the 2.1.0 bug: a funded meta-list address blocks setup | caught |
| `freeze-anyone` | anyone can freeze and thaw | caught |
| `freeze-authority-check-off` | Sentinel tries to freeze on a mint whose freeze authority is not its address (wrong error) | caught |
| `thaw-freezes` | `thaw_token_account` freezes | caught |
| `freeze-recorded-as-thaw` | a freeze is recorded as a thaw | caught |
| `unblock-recorded-as-block` | an unblock is recorded as a block | caught |
| `block-reason-dropped` | `block_wallet` records reason code 0 instead of the issuer's | caught |
| `freeze-case-ref-dropped` | a freeze or thaw records an empty case reference | caught |
| `freeze-event-wrong-wallet` | a freeze names the signer instead of the account's owner | caught |
| `freeze-event-wrong-account` | a freeze names the mint instead of the token account | caught |
| `set-freeze-authority-anyone` | anyone can move the freeze authority away from Sentinel | caught |
| `set-freeze-authority-check-off` | Sentinel tries to move a freeze authority it does not hold (wrong error) | caught |
| `freeze-authority-to-sentinel-allowed` | handing the freeze authority to Sentinel's own address is accepted | caught |
| `freeze-authority-change-recorded-wrong` | the record says the freeze authority was given up when it was handed on | caught |

A mutant that survives points to a gap in the model or in what the generator tries.
`accept-wrong-rent-receiver` survived the first run, because the generator rarely named a wrong
rent receiver when accepting a handover; it now does so more often. When 2.2 added freezes and
thaws, the new operations made two rare paths rarer, and `accept-wrong-rent-receiver` and
`any-block-entry-blocks` survived again. The generator now accepts a pending handover more often,
starts some cases with one already proposed, and passes a blocklisted wallet's entry as the fifth
account of a direct `Execute` more often.

## Coverage

`coverage.sh` builds the program unoptimized with debug information, runs the fuzz tests with
LiteSVM recording every instruction Sentinel executes, and maps the trace back to source lines with
[sbpf-coverage](https://github.com/LimeChain/sbpf-coverage) (a separate tool, installed with
`cargo install sbpf-coverage --version 0.2.12 --locked`). Traces are large, about 1.5 GB per 8
cases, so it runs in chunks and keeps only the coverage files.

```bash
bash tests-fuzz/coverage.sh       # from the repository root; about 10 minutes
```

On 16 October 2026 (48 cases, 2.3.0): **524 of the 543 lines of `lib.rs` that carry code were
executed (96.5%).** Every line added in 2.2 and 2.3 is among them except one `?`. The other 19:

| Lines | What | Why not here |
|---|---|---|
| 166–180 | `update_extra_account_meta_list` growing a list made before 2.1 | Every list made by 2.1 already has its full size. `scripts/upgrade-check.sh` covers it on a local validator: a 2.0.2 mint upgraded and migrated. |
| 604, 617, 637, 650 | the `?` after `ExtraAccountMeta::new_with_seeds` | The seeds are constants; these calls cannot fail. |
| 502, 515 | the `?` after the System transfer and `allocate` in `create_program_account` | The transfer fails only if the issuer cannot pay. A failing `allocate` does run (a second meta list), but the debug information does not attribute its exit to this line. |
| 706 | `false` when an account's data cannot be borrowed | Nothing else holds the account inside the hook. |
| 362 | the `?` after the `SetAuthority` call in `set_freeze_authority` (2.3) | The mint's constraint already ensures that Sentinel's address is the freeze authority, so Token-2022 accepts the call. The mutant that removes that constraint does reach it. |

Line coverage counts lines, not paths; the fuzz tests' value is in the model they check against.
