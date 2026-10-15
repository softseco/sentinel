// SPDX-License-Identifier: Apache-2.0
//
// Sentinel 2.2: blocking with a recorded reason, and freezing and thawing token accounts through
// Sentinel's freeze-authority address. A hook can only refuse transfers; a frozen account refuses
// everything.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  createInitializeAccount3Instruction,
  createMintToInstruction,
  getAccountLen,
  getAssociatedTokenAddressSync,
  getMint,
  ExtensionType,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { ENFORCEMENT_REASONS, SentinelClient, caseRef } from "../sdk/src";

const CONFIRM = { commitment: "confirmed" as const };
const SALT = "test-salt-not-for-production";

describe("sentinel — enforcement: reasons, freeze and thaw", () => {
  const provider = anchor.AnchorProvider.env();
  const client = new SentinelClient(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const mint = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const mallory = Keypair.generate();
  const stranger = Keypair.generate();
  const aliceSecond = Keypair.generate(); // a second token account of Alice's, not an ATA

  const ata = (owner: PublicKey, m: PublicKey = mint.publicKey) =>
    getAssociatedTokenAddressSync(m, owner, false, TOKEN_2022_PROGRAM_ID);
  const reason = (reasonCode: number, caseId: string) => ({ reasonCode, caseRef: caseRef(caseId, SALT) });

  /** The error text of a failed transaction, including its logs. */
  async function failure(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      const logs = e instanceof SendTransactionError ? ((await e.getLogs(connection)) ?? []) : [];
      return String(e) + "\n" + logs.join("\n");
    }
    assert.fail("expected the transaction to fail, but it went through");
  }

  const send = (ixs: TransactionInstruction[], signers: Keypair[] = []) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [payer, ...signers], CONFIRM);

  const transfer = (from: Keypair, to: PublicKey, amount: bigint, source?: PublicKey) =>
    client.transfer({ mint: mint.publicKey, amount, decimals: 0, owner: from, destinationOwner: to, source });

  /** A mint with Sentinel as hook, a blocklist policy, the meta list, and these holders. */
  async function setUpMint(
    m: Keypair,
    freezeAuthority: PublicKey | "sentinel" | null,
    holders: Keypair[],
  ): Promise<void> {
    await client.createCompliantMint({ mint: m, decimals: 0, freezeAuthority });
    await client.initializePolicy({ mint: m.publicKey, allowlist: false, blocklist: true, maxTransferAmount: 0 });
    await client.initializeExtraAccountMetaList(m.publicKey);
    await send(
      holders.flatMap((h) => [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata(h.publicKey, m.publicKey),
          h.publicKey,
          m.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createMintToInstruction(m.publicKey, ata(h.publicKey, m.publicKey), payer.publicKey, 100, [], TOKEN_2022_PROGRAM_ID),
      ]),
    );
  }

  before(async () => {
    for (const k of [alice, stranger]) {
      await connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), "confirmed");
    }
    await setUpMint(mint, "sentinel", [alice, bob, mallory]);
    // Alice's second account of the same mint.
    const len = getAccountLen([ExtensionType.TransferHookAccount]);
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: aliceSecond.publicKey,
          space: len,
          lamports: await connection.getMinimumBalanceForRentExemption(len),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(aliceSecond.publicKey, mint.publicKey, alice.publicKey, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(mint.publicKey, aliceSecond.publicKey, payer.publicKey, 50, [], TOKEN_2022_PROGRAM_ID),
      ],
      [aliceSecond],
    );
  });

  it("names Sentinel's freeze-authority address as the mint's freeze authority", async () => {
    const info = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.ok(info.freezeAuthority?.equals(client.freezeAuthority(mint.publicKey)));
  });

  it("records why a wallet was blocked and unblocked", async () => {
    const blocked = await client.blockWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.sanctions, "CASE-1"));
    assert.isTrue(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    const events = await client.getEvents(blocked);
    assert.deepEqual(
      events.map((e) => e.name),
      ["listEntryAdded", "enforcementAction"],
    );
    const action = events[1].data;
    assert.deepEqual(action.action, { block: {} });
    assert.equal(action.reasonCode, ENFORCEMENT_REASONS.sanctions);
    assert.deepEqual(Array.from(action.caseRef as number[]), Array.from(caseRef("CASE-1", SALT)));
    assert.ok((action.wallet as PublicKey).equals(mallory.publicKey));
    assert.ok((action.tokenAccount as PublicKey).equals(PublicKey.default));
    assert.ok((action.authority as PublicKey).equals(payer.publicKey));

    // The blocklist works as before: Mallory cannot receive.
    assert.match(await failure(() => transfer(alice, mallory.publicKey, 1n)), /RecipientBlocked/);

    const unblocked = await client.unblockWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "CASE-1"));
    assert.isFalse(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    const after = (await client.getEvents(unblocked)).find((e) => e.name === "enforcementAction");
    assert.deepEqual(after?.data.action, { unblock: {} });
    assert.equal(after?.data.reasonCode, ENFORCEMENT_REASONS.caseClosed);
  });

  it("freezes every token account of a wallet in one call", async () => {
    const signatures = await client.freezeWallet(mint.publicKey, alice.publicKey, reason(ENFORCEMENT_REASONS.courtOrder, "CASE-2"));
    assert.equal(signatures.length, 1);
    assert.isTrue(await client.isFrozen(ata(alice.publicKey)));
    assert.isTrue(await client.isFrozen(aliceSecond.publicKey));

    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.equal(actions.length, 2);
    const frozen = actions.map((a) => (a.data.tokenAccount as PublicKey).toBase58()).sort();
    assert.deepEqual(frozen, [ata(alice.publicKey), aliceSecond.publicKey].map((k) => k.toBase58()).sort());
    for (const a of actions) {
      assert.deepEqual(a.data.action, { freeze: {} });
      assert.ok((a.data.wallet as PublicKey).equals(alice.publicKey));
      assert.equal(a.data.reasonCode, ENFORCEMENT_REASONS.courtOrder);
    }
  });

  it("stops everything on a frozen account: sending, receiving, burning, approving", async () => {
    const frozenError = /0x11|frozen/i; // Token-2022 AccountFrozen
    assert.match(await failure(() => transfer(alice, bob.publicKey, 1n)), frozenError);
    assert.match(await failure(() => transfer(alice, bob.publicKey, 1n, aliceSecond.publicKey)), frozenError);
    assert.match(await failure(() => transfer(bob, alice.publicKey, 1n)), frozenError);
    assert.match(
      await failure(() =>
        send([createBurnCheckedInstruction(ata(alice.publicKey), mint.publicKey, alice.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)], [alice]),
      ),
      frozenError,
    );
    assert.match(
      await failure(() =>
        send(
          [createApproveCheckedInstruction(ata(alice.publicKey), mint.publicKey, mallory.publicKey, alice.publicKey, 1, 0, [], TOKEN_2022_PROGRAM_ID)],
          [alice],
        ),
      ),
      frozenError,
    );
  });

  it("lets only the policy authority freeze and thaw", async () => {
    const thawByStranger = await client.freezeInstruction({
      mint: mint.publicKey,
      tokenAccount: ata(alice.publicKey),
      enforcement: reason(0, "x"),
      thaw: true,
      authority: stranger.publicKey,
    });
    assert.match(await failure(() => send([thawByStranger], [stranger])), /Unauthorized/);
    const freezeByStranger = await client.freezeInstruction({
      mint: mint.publicKey,
      tokenAccount: ata(bob.publicKey),
      enforcement: reason(0, "x"),
      authority: stranger.publicKey,
    });
    assert.match(await failure(() => send([freezeByStranger], [stranger])), /Unauthorized/);
    assert.isFalse(await client.isFrozen(ata(bob.publicKey)));
  });

  it("refuses to freeze a frozen account or thaw a live one", async () => {
    assert.match(
      await failure(() => client.freezeTokenAccount(mint.publicKey, ata(alice.publicKey), reason(0, "x"))),
      /0xd|invalid state/i, // Token-2022 InvalidState
    );
    assert.match(
      await failure(() => client.thawTokenAccount(mint.publicKey, ata(bob.publicKey), reason(0, "x"))),
      /0xd|invalid state/i,
    );
  });

  it("thaws the wallet, and its tokens move again", async () => {
    const signatures = await client.thawWallet(mint.publicKey, alice.publicKey, reason(ENFORCEMENT_REASONS.caseClosed, "CASE-2"));
    assert.equal(signatures.length, 1);
    assert.isFalse(await client.isFrozen(ata(alice.publicKey)));
    assert.isFalse(await client.isFrozen(aliceSecond.publicKey));
    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.equal(actions.length, 2);
    for (const a of actions) assert.deepEqual(a.data.action, { thaw: {} });
    await transfer(alice, bob.publicKey, 5n);
    const accounts = await client.tokenAccountsOf(mint.publicKey, bob.publicKey);
    assert.equal(accounts[0].amount, 105n);
  });

  it("blocks and freezes a wallet in one transaction", async () => {
    const signatures = await client.blockAndFreezeWallet(mint.publicKey, mallory.publicKey, reason(ENFORCEMENT_REASONS.fraud, "CASE-3"));
    assert.equal(signatures.length, 1);
    assert.isTrue(await client.isBlocklisted(mint.publicKey, mallory.publicKey));
    assert.isTrue(await client.isFrozen(ata(mallory.publicKey)));
    const actions = (await client.getEvents(signatures[0])).filter((e) => e.name === "enforcementAction");
    assert.deepEqual(
      actions.map((a) => a.data.action),
      [{ block: {} }, { freeze: {} }],
    );
  });

  it("refuses to freeze through Sentinel when the mint's freeze authority is someone else, until it is handed over", async () => {
    const other = Keypair.generate();
    await setUpMint(other, payer.publicKey, [bob]);
    const error = await failure(() => client.freezeTokenAccount(other.publicKey, ata(bob.publicKey, other.publicKey), reason(0, "x")));
    assert.match(error, /FreezeAuthorityNotSentinel/);

    await client.setSentinelAsFreezeAuthority(other.publicKey, payer);
    await client.freezeTokenAccount(other.publicKey, ata(bob.publicKey, other.publicKey), reason(0, "x"));
    assert.isTrue(await client.isFrozen(ata(bob.publicKey, other.publicKey)));
  });

  it("refuses to freeze through Sentinel on a mint without a freeze authority", async () => {
    const none = Keypair.generate();
    await setUpMint(none, null, [bob]);
    const error = await failure(() => client.freezeTokenAccount(none.publicKey, ata(bob.publicKey, none.publicKey), reason(0, "x")));
    assert.match(error, /FreezeAuthorityNotSentinel/);
  });

  it("checks reason codes and case references before sending", async () => {
    let message = "";
    try {
      await client.blockWalletInstruction({ mint: mint.publicKey, wallet: bob.publicKey, enforcement: { reasonCode: 70_000, caseRef: new Uint8Array(32) } });
    } catch (e) {
      message = String(e);
    }
    assert.match(message, /reasonCode/);
    try {
      await client.blockWalletInstruction({ mint: mint.publicKey, wallet: bob.publicKey, enforcement: { reasonCode: 1, caseRef: new Uint8Array(31) } });
    } catch (e) {
      message = String(e);
    }
    assert.match(message, /32 bytes/);
  });
});
