#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Break the program on purpose and check that the fuzz tests notice.

Each mutant is one small change to programs/sentinel/src/lib.rs that a real bug could look like:
a dropped authority check, a rule switched off, an off-by-one. For each, the script builds the
program into a temporary folder, runs the model-based fuzz tests against that build, and records
whether they failed ("caught") or passed ("missed"). lib.rs is always restored.

    python3 tests-fuzz/mutants.py              # all mutants, 64 cases each
    python3 tests-fuzz/mutants.py limit allow  # only the mutants whose name contains a word
    FUZZ_CASES=256 python3 tests-fuzz/mutants.py
    SBF_ARGS="--tools-version v1.57" python3 tests-fuzz/mutants.py  # extra cargo build-sbf flags

Needs `cargo build-sbf` (Solana CLI) on PATH. Takes about a minute per mutant.
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "programs/sentinel/src/lib.rs")

HAS_ONE = "        has_one = authority @ SentinelError::Unauthorized,\n"


def drop_has_one(struct):
    """Remove the `has_one = authority` check from the policy account of `struct`."""
    start = f"pub struct {struct}<'info> {{\n"

    def apply(src):
        i = src.index(start)
        j = src.index(HAS_ONE, i)
        assert j < src.index("\n}\n", i), f"{struct} has no has_one check"
        return src[:j] + src[j + len(HAS_ONE):]

    return apply


def in_struct(struct, old, new):
    """Replace `old` with `new` inside the accounts struct `struct` only."""
    start = f"pub struct {struct}<'info> {{\n"

    def apply(src):
        i = src.index(start)
        j = src.index("\n}\n", i)
        block = src[i:j]
        assert block.count(old) == 1, f"not exactly one match in {struct} for: {old!r}"
        return src[:i] + block.replace(old, new) + src[j:]

    return apply


def replace(old, new):
    def apply(src):
        assert src.count(old) == 1, f"not exactly one match for: {old!r}"
        return src.replace(old, new)

    return apply


MUTANTS = [
    # The hook's rules.
    ("limit-off-by-one", replace("} else if amount > policy.max_transfer_amount {",
                                 "} else if amount >= policy.max_transfer_amount {")),
    ("limit-ignored", replace("if policy.max_transfer_amount > 0 {", "if false {")),
    ("confidential-limit-ignored", replace("if !policy.allow_confidential {", "if false {")),
    ("sender-blocklist-off", replace("if is_active(&ctx.accounts.source_block, ctx.program_id) {",
                                     "if false && is_active(&ctx.accounts.source_block, ctx.program_id) {")),
    ("recipient-blocklist-off", replace("if is_active(&ctx.accounts.dest_block, ctx.program_id) {",
                                        "if false && is_active(&ctx.accounts.dest_block, ctx.program_id) {")),
    ("authority-blocklist-off", replace("return Err(SentinelError::AuthorityBlocked);", "return Ok(());")),
    ("blocklist-flag-ignored", replace("if policy.blocklist_enabled {", "if true {")),
    ("allowlist-off", replace("if policy.allowlist_enabled && !is_active(",
                              "if false && policy.allowlist_enabled && !is_active(")),
    ("any-block-entry-blocks", replace("Ok(entry) => entry.mint == *mint && entry.wallet == *wallet,",
                                       "Ok(_) => true,")),
    ("rules-in-wrong-order", replace(
        "        if is_active(&ctx.accounts.source_block, ctx.program_id) {\n            return Err(SentinelError::SenderBlocked);\n        }\n        if is_active(&ctx.accounts.dest_block, ctx.program_id) {\n            return Err(SentinelError::RecipientBlocked);\n        }",
        "        if is_active(&ctx.accounts.dest_block, ctx.program_id) {\n            return Err(SentinelError::RecipientBlocked);\n        }\n        if is_active(&ctx.accounts.source_block, ctx.program_id) {\n            return Err(SentinelError::SenderBlocked);\n        }")),
    # Who may change what.
    ("update-policy-anyone", drop_has_one("UpdatePolicy")),
    ("add-allow-anyone", drop_has_one("AddToAllowlist")),
    ("remove-allow-anyone", drop_has_one("RemoveFromAllowlist")),
    ("add-block-anyone", drop_has_one("AddToBlocklist")),
    ("remove-block-anyone", drop_has_one("RemoveFromBlocklist")),
    ("update-meta-list-anyone", drop_has_one("UpdateExtraAccountMetaList")),
    ("propose-anyone", drop_has_one("ProposeAuthority")),
    ("cancel-anyone", drop_has_one("CancelAuthorityTransfer")),
    ("accept-anyone", replace(
        "        constraint = pending_authority.new_authority == new_authority.key() @ SentinelError::Unauthorized,\n", "")),
    ("accept-wrong-rent-receiver", replace(
        "    #[account(mut, address = policy_config.authority @ SentinelError::Unauthorized)]",
        "    #[account(mut)]")),
    ("propose-to-self", replace("new_authority != Pubkey::default() && new_authority != current",
                                "new_authority != Pubkey::default()")),
    ("init-policy-anyone", replace(
        "        constraint = mint.mint_authority == COption::Some(authority.key()) @ SentinelError::Unauthorized,\n", "")),
    ("init-meta-list-anyone", replace(
        "        constraint = mint.mint_authority == COption::Some(payer.key()) @ SentinelError::Unauthorized,\n", "")),
    ("update-policy-keeps-flag", replace("policy.blocklist_enabled = blocklist_enabled;", "")),
    ("accept-keeps-old-authority", replace("policy.authority = ctx.accounts.new_authority.key();", "")),
    # Setup.
    ("funded-address-blocks-setup", replace("if current == 0 {", "if true {")),
    # Freezing and the enforcement record (2.2).
    ("freeze-anyone", drop_has_one("SetFrozen")),
    ("freeze-authority-check-off", in_struct(
        "SetFrozen",
        "constraint = mint.freeze_authority == COption::Some(freeze_authority.key())",
        "constraint = true")),
    ("thaw-freezes", replace("        set_frozen(&ctx, false)?;", "        set_frozen(&ctx, true)?;")),
    ("freeze-recorded-as-thaw", replace(
        "emit_frozen(&ctx, EnforcementKind::Freeze, reason_code, case_ref);",
        "emit_frozen(&ctx, EnforcementKind::Thaw, reason_code, case_ref);")),
    ("unblock-recorded-as-block", replace("            action: EnforcementKind::Unblock,",
                                          "            action: EnforcementKind::Block,")),
    ("block-reason-dropped", replace(
        "            action: EnforcementKind::Block,\n            reason_code,\n",
        "            action: EnforcementKind::Block,\n            reason_code: 0,\n")),
    ("freeze-case-ref-dropped", replace(
        "\n        case_ref,\n        authority: ctx.accounts.authority.key(),\n    });\n}",
        "\n        case_ref: [0; 32],\n        authority: ctx.accounts.authority.key(),\n    });\n}")),
    ("freeze-event-wrong-wallet", replace(
        "        wallet: token_account_owner(&ctx.accounts.token_account),\n",
        "        wallet: ctx.accounts.authority.key(),\n")),
    ("freeze-event-wrong-account", replace(
        "        token_account: ctx.accounts.token_account.key(),\n",
        "        token_account: ctx.accounts.mint.key(),\n")),
    # Handing the freeze authority on (2.3).
    ("set-freeze-authority-anyone", drop_has_one("SetFreezeAuthority")),
    ("set-freeze-authority-check-off", in_struct(
        "SetFreezeAuthority",
        "constraint = mint.freeze_authority == COption::Some(freeze_authority.key())",
        "constraint = true")),
    ("freeze-authority-to-sentinel-allowed", replace(
        "new != Pubkey::default() && new != sentinel", "new != Pubkey::default()")),
    ("freeze-authority-change-recorded-wrong", replace(
        "            new_freeze_authority,\n            reason_code,\n",
        "            new_freeze_authority: None,\n            reason_code,\n")),
]


def build(src, out_dir):
    with open(LIB, "w") as f:
        f.write(src)
    r = subprocess.run(
        ["cargo", "build-sbf", "--manifest-path", "programs/sentinel/Cargo.toml", "--sbf-out-dir", out_dir]
        + os.environ.get("SBF_ARGS", "").split(),
        cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-2000:])
    return os.path.join(out_dir, "sentinel.so")


def fuzz(so):
    env = dict(os.environ, SENTINEL_SO=so)
    r = subprocess.run(["cargo", "test", "--test", "model", "--", "--nocapture"],
                       cwd=os.path.join(ROOT, "tests-fuzz"), env=env, capture_output=True, text=True)
    if r.returncode == 0:
        return None
    for line in (r.stdout + r.stderr).splitlines():
        if "step" in line and "case" in line:
            return line.strip()
    return "failed"


def main():
    words = sys.argv[1:]
    chosen = [m for m in MUTANTS if not words or any(w in m[0] for w in words)]
    original = open(LIB).read()
    for name, apply in chosen:
        apply(original)  # fails fast if a mutant no longer matches the source
    results = []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            for name, apply in chosen:
                so = build(apply(original), os.path.join(tmp, name))
                verdict = fuzz(so)
                results.append((name, verdict))
                print(f"{name:<28} {'caught' if verdict else 'MISSED'}  {verdict or ''}", flush=True)
    finally:
        with open(LIB, "w") as f:
            f.write(original)
    caught = sum(1 for _, v in results if v)
    print(f"\n{caught} of {len(results)} mutants caught")
    sys.exit(0 if caught == len(results) else 1)


if __name__ == "__main__":
    main()
