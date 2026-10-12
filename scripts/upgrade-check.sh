#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Check the upgrade path from an older release to the program in this working tree, on a local
# validator: build both, start the validator with the old program (upgradeable), and run
# tests-upgrade/, which sets a mint up under the old program, upgrades in place, and checks that
# the mint keeps working and can be migrated.
#
#   bash scripts/upgrade-check.sh            # from v2.0.2
#   bash scripts/upgrade-check.sh v2.0.1     # from another tag
set -euo pipefail
FROM="${1:-v2.0.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
ZK_GATE="zkdoVwnSFnSLtGJG7irJPEYUpmb4i7sGMGcnN6T9rnC"   # the ZK ElGamal Proof Program's off switch
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SENTINEL="5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD"
# SIMD-0500 stops new deployments of SBPF v0-v2 binaries, which is what cargo build-sbf produces
# by default. The test validator turns every feature on, so turn this one off to let the upgrade
# deploy the same kind of binary Sentinel has been deployed with so far.
SBPF_V0_DEPLOY_OFF="B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g"

echo "=== building $FROM ==="
git -C "$ROOT" worktree add --quiet --detach "$WORK/old" "$FROM"
cleanup() {
  [ -n "${VALIDATOR:-}" ] && kill "$VALIDATOR" 2>/dev/null || true
  git -C "$ROOT" worktree remove --force "$WORK/old" 2>/dev/null || true
}
trap cleanup EXIT
(cd "$WORK/old" && cargo build-sbf --manifest-path programs/sentinel/Cargo.toml ${SBF_ARGS:-})
echo "=== building the working tree ==="
(cd "$ROOT" && cargo build-sbf --manifest-path programs/sentinel/Cargo.toml ${SBF_ARGS:-})

WALLET="$(solana address)"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --deactivate-feature "$ZK_GATE" \
  --deactivate-feature "$SBPF_V0_DEPLOY_OFF" \
  --upgradeable-program "$TOKEN_2022" "$ROOT/tests/fixtures/spl_token_2022.so" "$WALLET" \
  --upgradeable-program "$SENTINEL" "$WORK/old/target/deploy/sentinel.so" "$WALLET" >/dev/null &
VALIDATOR=$!
for _ in $(seq 1 60); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
  sleep 1
done

cd "$ROOT"
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}" \
NEW_PROGRAM_SO="$ROOT/target/deploy/sentinel.so" \
  npx ts-mocha -p ./tsconfig.json -t 1000000 'tests-upgrade/**/*.ts'
