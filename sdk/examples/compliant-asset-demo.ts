// SPDX-License-Identifier: Apache-2.0
//
// Sentinel demo — a compliant tokenized asset ("ACME") on Token-2022.
//
// Shows the compliance engine gating real transfers: allowlist, blocklist, a
// per-transfer limit, and a live policy update. Run against a local validator
// with the Sentinel program deployed:
//
//   Terminal 1:  cd ~/sentinel && anchor localnet
//   Terminal 2:  cd ~/sentinel/sdk && npm run demo
//
// The demo funds its own wallet via airdrop, so nothing needs pre-funding.
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { SentinelClient } from "../src";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const DECIMALS = 0;

const line = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const issuer = Keypair.generate();

  line("┌──────────────────────────────────────────────────────────┐");
  line("│   Sentinel — Compliant Tokenized Asset demo (ACME)       │");
  line("└──────────────────────────────────────────────────────────┘");

  const airdrop = await connection.requestAirdrop(issuer.publicKey, 5 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdrop, "confirmed");

  const provider = new AnchorProvider(connection, new Wallet(issuer), { commitment: "confirmed" });
  const sentinel = new SentinelClient(provider);

  // Cast of holders.
  const alice = Keypair.generate(); // KYC'd, allowlisted
  const bob = Keypair.generate(); // KYC'd, allowlisted
  const carol = Keypair.generate(); // not KYC'd, NOT allowlisted
  const mallory = Keypair.generate(); // KYC'd, then sanctioned
  const mintKp = Keypair.generate();

  step("1. Issue the ACME security token (Token-2022 + Sentinel transfer hook)");
  await sentinel.createCompliantMint({ mint: mintKp, decimals: DECIMALS });
  const mint = mintKp.publicKey;
  line(`   mint: ${mint.toBase58()}`);

  step("2. Set the compliance policy — allowlist ON, blocklist ON, max 1000 / transfer");
  await sentinel.initializePolicy({ mint, allowlist: true, blocklist: true, maxTransferAmount: 1000 });
  await sentinel.initializeExtraAccountMetaList(mint);

  step("3. Mint 10,000 ACME to the issuer");
  const issuerAta = await getOrCreateAssociatedTokenAccount(
    connection, issuer, mint, issuer.publicKey, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
  );
  await mintTo(
    connection, issuer, mint, issuerAta.address, issuer.publicKey, 10_000, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
  );

  step("4. Open investor accounts + KYC (allowlist) Alice, Bob, Mallory");
  for (const who of [alice, bob, carol, mallory]) {
    await getOrCreateAssociatedTokenAccount(
      connection, issuer, mint, who.publicKey, true, "confirmed", undefined, TOKEN_2022_PROGRAM_ID
    );
  }
  await sentinel.addToAllowlist(mint, alice.publicKey);
  await sentinel.addToAllowlist(mint, bob.publicKey);
  await sentinel.addToAllowlist(mint, mallory.publicKey);
  line("   allowlisted: Alice, Bob, Mallory    not allowlisted: Carol");

  step("5. Move the asset under the policy");
  await attempt(sentinel, mint, "Issuer → Alice    500   (allowlisted, within limit)", alice.publicKey, 500);
  await attempt(sentinel, mint, "Issuer → Carol    500   (not allowlisted)", carol.publicKey, 500, "recipient not allowlisted");
  await attempt(sentinel, mint, "Issuer → Alice   2000   (over the 1000 limit)", alice.publicKey, 2000, "exceeds transfer limit");

  step("6. Mallory is sanctioned → added to the blocklist");
  await sentinel.addToBlocklist(mint, mallory.publicKey);
  await attempt(sentinel, mint, "Issuer → Mallory  100   (allowlisted BUT sanctioned)", mallory.publicKey, 100, "recipient sanctioned");

  step("7. Issuer raises the per-transfer limit to 5000 (live policy update)");
  await sentinel.updatePolicy({ mint, allowlist: true, blocklist: true, maxTransferAmount: 5000 });
  await attempt(sentinel, mint, "Issuer → Alice   2000   (now within the new limit)", alice.publicKey, 2000);

  step("Final cap table");
  for (const [name, kp] of [["Alice", alice], ["Bob", bob], ["Carol", carol], ["Mallory", mallory]] as const) {
    line(`   ${name.padEnd(9)} ${await balanceOf(connection, mint, kp.publicKey)} ACME`);
  }
  line("\n✔ A cap table enforced on-chain — Sentinel decided every transfer.\n");
}

async function attempt(
  sentinel: SentinelClient,
  mint: PublicKey,
  label: string,
  destinationOwner: PublicKey,
  amount: number,
  blockedReason?: string
) {
  try {
    await sentinel.transfer({ mint, destinationOwner, amount, decimals: DECIMALS });
    console.log(`   \x1b[32m✅ ${label}\x1b[0m`);
  } catch {
    console.log(`   \x1b[31m⛔ ${label}\x1b[0m  → ${blockedReason ?? "blocked"}`);
  }
}

async function balanceOf(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<string> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  try {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return acc.amount.toString().padStart(5);
  } catch {
    return "    0";
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
