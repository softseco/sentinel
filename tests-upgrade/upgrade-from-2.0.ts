// SPDX-License-Identifier: Apache-2.0
//
// Upgrade path from 2.0.x to the current program, on a local validator: a mint set up by the old
// program keeps working after the upgrade, and `update_extra_account_meta_list` then turns on the
// delegate check. Run by scripts/upgrade-check.sh, which starts the validator with the old program
// (upgradeable, authority = the provider wallet) and passes the new binary in NEW_PROGRAM_SO.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CONFIRM = { commitment: "confirmed" as const };
const PROGRAM_ID = new PublicKey("5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD");

describe("sentinel — upgrade from 2.0.x", function () {
  this.timeout(300_000);
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  // The old IDL is a subset of the new one: every 2.0 instruction is unchanged in 2.1.
  const program = new anchor.Program(JSON.parse(readFileSync("sdk/src/idl/sentinel.json", "utf8")), provider);
  const mint = Keypair.generate();
  const [alice, bob, mallory] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const policy = pda([Buffer.from("policy"), mint.publicKey.toBuffer()]);
  const metaList = pda([Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()]);
  const block = (w: PublicKey) => pda([Buffer.from("block"), mint.publicKey.toBuffer(), w.toBuffer()]);
  const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, o, true, TOKEN_2022_PROGRAM_ID);
  const balance = async (o: PublicKey) => (await getAccount(connection, ata(o), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  async function transfer(from: PublicKey, to: PublicKey, authority: Keypair, amount: bigint): Promise<string> {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, ata(from), mint.publicKey, ata(to), authority.publicKey, amount, 0, [], "confirmed", TOKEN_2022_PROGRAM_ID
    );
    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, authority], CONFIRM);
      return "ok";
    } catch (e) {
      return String(e).match(/Error Code: (\w+)/)?.[1] ?? String(e).slice(0, 200);
    }
  }

  it("sets a mint up under the old program", async () => {
    for (const k of [alice, mallory]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
    }
    const len = getMintLen([ExtensionType.TransferHook]);
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await connection.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, 0, payer.publicKey, null, TOKEN_2022_PROGRAM_ID)
    ), [payer, mint], CONFIRM);
    await program.methods.initializePolicy(false, true, new BN(0), false)
      .accountsPartial({ authority: payer.publicKey, mint: mint.publicKey, policyConfig: policy, systemProgram: SystemProgram.programId }).rpc(CONFIRM);
    await program.methods.initializeExtraAccountMetaList()
      .accountsPartial({ payer: payer.publicKey, extraAccountMetaList: metaList, mint: mint.publicKey, systemProgram: SystemProgram.programId }).rpc(CONFIRM);
    const tx = new Transaction();
    for (const o of [alice, bob, mallory]) {
      tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, ata(o.publicKey), o.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }
    tx.add(createMintToInstruction(mint.publicKey, ata(alice.publicKey), payer.publicKey, 1000, [], TOKEN_2022_PROGRAM_ID));
    tx.add(createApproveCheckedInstruction(ata(alice.publicKey), mint.publicKey, mallory.publicKey, alice.publicKey, 500, 0, [], TOKEN_2022_PROGRAM_ID));
    await sendAndConfirmTransaction(connection, tx, [payer, alice], CONFIRM);
    await program.methods.addToBlocklist()
      .accountsPartial({ authority: payer.publicKey, mint: mint.publicKey, policyConfig: policy, wallet: mallory.publicKey, blockEntry: block(mallory.publicKey) }).rpc(CONFIRM);

    const list = await connection.getAccountInfo(metaList);
    console.log(`      old meta list: ${list!.data.length} bytes`);
    assert.equal(await transfer(alice.publicKey, bob.publicKey, alice, 10n), "ok");
    // The 2.0 gap: a blocklisted delegate gets through.
    assert.equal(await transfer(alice.publicKey, bob.publicKey, mallory, 10n), "ok");
  });

  it("upgrades the program in place", async () => {
    const so = process.env.NEW_PROGRAM_SO;
    assert.ok(so, "set NEW_PROGRAM_SO to the new sentinel.so");
    const out = execFileSync("solana", ["program", "deploy", so!, "--program-id", PROGRAM_ID.toBase58(), "--url", connection.rpcEndpoint], { encoding: "utf8" });
    console.log("      " + out.trim().split("\n").pop());
    await new Promise((r) => setTimeout(r, 2000)); // the new code is visible from the next slot
  });

  it("keeps the old mint working, with the old meta list", async () => {
    assert.equal(await transfer(alice.publicKey, bob.publicKey, alice, 10n), "ok");
    const p = await (program.account as any).policyConfig.fetch(policy);
    assert.isTrue(p.blocklistEnabled);
    assert.equal(await transfer(alice.publicKey, mallory.publicKey, alice, 1n), "RecipientBlocked");
    // Until the meta list is updated, the hook does not receive the authority's entry.
    assert.equal(await transfer(alice.publicKey, bob.publicKey, mallory, 10n), "ok");
  });

  it("turns the delegate check on with update_extra_account_meta_list", async () => {
    await program.methods.updateExtraAccountMetaList()
      .accountsPartial({ authority: payer.publicKey, mint: mint.publicKey, policyConfig: policy, extraAccountMetaList: metaList, systemProgram: SystemProgram.programId }).rpc(CONFIRM);
    const list = await connection.getAccountInfo(metaList);
    console.log(`      new meta list: ${list!.data.length} bytes`);
    assert.equal(await transfer(alice.publicKey, bob.publicKey, mallory, 10n), "AuthorityBlocked");
    assert.equal(await transfer(alice.publicKey, bob.publicKey, alice, 10n), "ok");
    assert.equal(await balance(bob.publicKey), 50n);
  });
});
