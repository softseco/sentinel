// SPDX-License-Identifier: Apache-2.0
import { AnchorProvider, BN, BorshCoder, EventParser, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import idl from "./idl/sentinel.json";
import type { Sentinel } from "./idl/sentinel";
import { allowEntryPda, blockEntryPda, metaListPda, pendingAuthorityPda, policyPda } from "./pdas";

const CONFIRM = { commitment: "confirmed" as const };

/**
 * How many allow or block list changes the batch helpers put in one transaction. Each one creates
 * or closes an account, so this stays well inside the transaction size and compute limits.
 */
export const MAX_LIST_UPDATES_PER_TX = 8;

/**
 * An event emitted by the program, decoded from transaction logs. `name` is camelCase, for
 * example `transferRefused`, `policyUpdated`, `listEntryAdded` or `authorityTransferred`.
 */
export interface SentinelEvent {
  name: string;
  data: Record<string, unknown>;
}

type ListName = "allow" | "block";
type ListAction = "add" | "remove";

/** A decoded view of a mint's compliance policy. */
export interface PolicyView {
  mint: PublicKey;
  authority: PublicKey;
  allowlistEnabled: boolean;
  blocklistEnabled: boolean;
  maxTransferAmount: bigint;
  /**
   * Whether confidential transfers are permitted on a mint that also sets
   * `maxTransferAmount`. The hook cannot see an encrypted amount, so the limit
   * is unenforceable for those transfers and the issuer opts in explicitly.
   */
  allowConfidential: boolean;
}

/**
 * Client for the Sentinel compliance program. Wraps mint creation, policy
 * management, allow/blocklist entries, hook-aware transfers, and reads.
 */
export class SentinelClient {
  readonly program: Program<Sentinel>;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;

  constructor(provider: AnchorProvider) {
    this.provider = provider;
    this.program = new Program<Sentinel>(idl as Sentinel, provider);
    this.programId = this.program.programId;
  }

  // ---- PDA helpers ----
  policy(mint: PublicKey): PublicKey {
    return policyPda(mint, this.programId);
  }
  metaList(mint: PublicKey): PublicKey {
    return metaListPda(mint, this.programId);
  }
  allowEntry(mint: PublicKey, wallet: PublicKey): PublicKey {
    return allowEntryPda(mint, wallet, this.programId);
  }
  blockEntry(mint: PublicKey, wallet: PublicKey): PublicKey {
    return blockEntryPda(mint, wallet, this.programId);
  }
  pendingAuthority(mint: PublicKey): PublicKey {
    return pendingAuthorityPda(mint, this.programId);
  }

  private get connection() {
    return this.provider.connection;
  }
  private get payer(): Signer {
    return (this.provider.wallet as unknown as { payer: Signer }).payer;
  }

  /** Create a Token-2022 mint whose transfer hook is Sentinel. Signs with `mint`. */
  async createCompliantMint(params: {
    mint: Keypair;
    decimals: number;
    mintAuthority?: PublicKey;
  }): Promise<PublicKey> {
    const authority = params.mintAuthority ?? this.payer.publicKey;
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const lamports = await this.connection.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: params.mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        params.mint.publicKey,
        this.payer.publicKey,
        this.programId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        params.mint.publicKey,
        params.decimals,
        authority,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(this.connection, tx, [this.payer, params.mint], CONFIRM);
    return params.mint.publicKey;
  }

  /** Create the mint's policy. The provider wallet becomes its authority. */
  initializePolicy(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    /** Permit confidential transfers even though the limit cannot apply to them. */
    allowConfidential?: boolean;
  }): Promise<string> {
    return this.program.methods
      .initializePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  /** Update the mint's policy (authority only). */
  updatePolicy(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    /** Permit confidential transfers even though the limit cannot apply to them. */
    allowConfidential?: boolean;
  }): Promise<string> {
    return this.program.methods
      .updatePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
      })
      .rpc(CONFIRM);
  }

  /** Initialize the mint's ExtraAccountMetaList so Token-2022 invokes the hook. */
  initializeExtraAccountMetaList(mint: PublicKey): Promise<string> {
    return this.program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        payer: this.payer.publicKey,
        extraAccountMetaList: this.metaList(mint),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  addToAllowlist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.program.methods
      .addToAllowlist()
      .accountsPartial({
        authority: this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        allowEntry: this.allowEntry(mint, wallet),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  removeFromAllowlist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.program.methods
      .removeFromAllowlist()
      .accountsPartial({
        authority: this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        allowEntry: this.allowEntry(mint, wallet),
      })
      .rpc(CONFIRM);
  }

  addToBlocklist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.program.methods
      .addToBlocklist()
      .accountsPartial({
        authority: this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
        systemProgram: SystemProgram.programId,
      })
      .rpc(CONFIRM);
  }

  removeFromBlocklist(mint: PublicKey, wallet: PublicKey): Promise<string> {
    return this.program.methods
      .removeFromBlocklist()
      .accountsPartial({
        authority: this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
      })
      .rpc(CONFIRM);
  }

  // ---- Instruction builders ----
  //
  // Every authority-gated instruction, with the authority as a parameter. Use these when the
  // policy authority is a multisig (for example a Squads vault): build the instruction with the
  // vault's address as `authority` and propose it in the multisig instead of signing here.

  /** `update_policy`, signed by `authority` (default: the provider wallet). */
  updatePolicyInstruction(params: {
    mint: PublicKey;
    allowlist: boolean;
    blocklist: boolean;
    maxTransferAmount: bigint | number;
    allowConfidential?: boolean;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    return this.program.methods
      .updatePolicy(
        params.allowlist,
        params.blocklist,
        new BN(params.maxTransferAmount.toString()),
        params.allowConfidential ?? false,
      )
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint: params.mint,
        policyConfig: this.policy(params.mint),
      })
      .instruction();
  }

  /** Add or remove one wallet on the allowlist or blocklist, signed by `authority`. */
  listInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    list: ListName;
    action: ListAction;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const base = {
      authority: params.authority ?? this.payer.publicKey,
      mint,
      policyConfig: this.policy(mint),
      wallet,
    };
    if (params.list === "allow") {
      const allowEntry = this.allowEntry(mint, wallet);
      return params.action === "add"
        ? this.program.methods
            .addToAllowlist()
            .accountsPartial({ ...base, allowEntry, systemProgram: SystemProgram.programId })
            .instruction()
        : this.program.methods.removeFromAllowlist().accountsPartial({ ...base, allowEntry }).instruction();
    }
    const blockEntry = this.blockEntry(mint, wallet);
    return params.action === "add"
      ? this.program.methods
          .addToBlocklist()
          .accountsPartial({ ...base, blockEntry, systemProgram: SystemProgram.programId })
          .instruction()
      : this.program.methods.removeFromBlocklist().accountsPartial({ ...base, blockEntry }).instruction();
  }

  /** `propose_authority`: start handing the policy to `newAuthority`. */
  proposeAuthorityInstruction(
    mint: PublicKey,
    newAuthority: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .proposeAuthority(newAuthority)
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `accept_authority`, signed by the proposed authority. `previousAuthority` gets the proposal's rent back. */
  acceptAuthorityInstruction(
    mint: PublicKey,
    newAuthority: PublicKey,
    previousAuthority: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .acceptAuthority()
      .accountsPartial({
        newAuthority,
        previousAuthority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
      })
      .instruction();
  }

  /** `cancel_authority_transfer`, signed by the current authority. */
  cancelAuthorityTransferInstruction(
    mint: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .cancelAuthorityTransfer()
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        pendingAuthority: this.pendingAuthority(mint),
      })
      .instruction();
  }

  /** `update_extra_account_meta_list`, signed by the policy authority (who pays any extra rent). */
  updateExtraAccountMetaListInstruction(
    mint: PublicKey,
    authority: PublicKey = this.payer.publicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateExtraAccountMetaList()
      .accountsPartial({
        authority,
        mint,
        policyConfig: this.policy(mint),
        extraAccountMetaList: this.metaList(mint),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  // ---- Authority handover (provider wallet as the current authority) ----

  /** Propose `newAuthority` as the policy authority. Nothing changes until it accepts. */
  async proposeAuthority(mint: PublicKey, newAuthority: PublicKey): Promise<string> {
    return this.send([await this.proposeAuthorityInstruction(mint, newAuthority)]);
  }

  /** Accept a pending handover. `newAuthority` must sign. */
  async acceptAuthority(mint: PublicKey, newAuthority: Signer): Promise<string> {
    const policy = await this.getPolicy(mint);
    if (!policy) throw new Error(`no Sentinel policy for mint ${mint.toBase58()}`);
    const ix = await this.acceptAuthorityInstruction(mint, newAuthority.publicKey, policy.authority);
    return this.send([ix], [newAuthority]);
  }

  /** Withdraw a pending handover. */
  async cancelAuthorityTransfer(mint: PublicKey): Promise<string> {
    return this.send([await this.cancelAuthorityTransferInstruction(mint)]);
  }

  /** The authority a handover is waiting for, or `null` if none is pending. */
  async getPendingAuthority(mint: PublicKey): Promise<PublicKey | null> {
    const pending = await this.program.account.pendingAuthority.fetchNullable(this.pendingAuthority(mint));
    return pending ? pending.newAuthority : null;
  }

  /**
   * Bring a mint's ExtraAccountMetaList up to the current program's list. Mints set up before
   * 2.1 need this once so the blocklist also covers delegates. Safe to run again.
   */
  async updateExtraAccountMetaList(mint: PublicKey): Promise<string> {
    return this.send([await this.updateExtraAccountMetaListInstruction(mint)]);
  }

  // ---- Batch list updates ----

  /** Allowlist many wallets, `MAX_LIST_UPDATES_PER_TX` per transaction. Returns the signatures. */
  addToAllowlistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "allow", "add");
  }

  /** Remove many wallets from the allowlist. */
  removeFromAllowlistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "allow", "remove");
  }

  /** Blocklist many wallets, for example from a sanctions list. */
  addToBlocklistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "block", "add");
  }

  /** Remove many wallets from the blocklist. */
  removeFromBlocklistBatch(mint: PublicKey, wallets: PublicKey[]): Promise<string[]> {
    return this.listBatch(mint, wallets, "block", "remove");
  }

  private async listBatch(
    mint: PublicKey,
    wallets: PublicKey[],
    list: ListName,
    action: ListAction,
  ): Promise<string[]> {
    const signatures: string[] = [];
    for (let i = 0; i < wallets.length; i += MAX_LIST_UPDATES_PER_TX) {
      const chunk = wallets.slice(i, i + MAX_LIST_UPDATES_PER_TX);
      const ixs = await Promise.all(chunk.map((wallet) => this.listInstruction({ mint, wallet, list, action })));
      signatures.push(await this.send(ixs));
    }
    return signatures;
  }

  // ---- Events ----

  /** Decode Sentinel events from transaction logs (including the logs of a failed transaction). */
  parseEvents(logs: string[]): SentinelEvent[] {
    const parser = new EventParser(this.programId, new BorshCoder(this.program.idl));
    return [...parser.parseLogs(logs)].map((e) => ({ name: e.name, data: e.data as Record<string, unknown> }));
  }

  /** Decode the Sentinel events of a confirmed transaction. */
  async getEvents(signature: string): Promise<SentinelEvent[]> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return this.parseEvents(tx?.meta?.logMessages ?? []);
  }

  private send(instructions: TransactionInstruction[], extraSigners: Signer[] = []): Promise<string> {
    return sendAndConfirmTransaction(
      this.connection,
      new Transaction().add(...instructions),
      [this.payer, ...extraSigners],
      CONFIRM,
    );
  }

  /** Transfer tokens through the hook (extra accounts resolved automatically). */
  async transfer(params: {
    mint: PublicKey;
    amount: bigint | number;
    decimals: number;
    destinationOwner?: PublicKey;
    destination?: PublicKey;
    owner?: Signer;
    source?: PublicKey;
  }): Promise<string> {
    const owner = params.owner ?? this.payer;
    const source =
      params.source ??
      getAssociatedTokenAddressSync(params.mint, owner.publicKey, true, TOKEN_2022_PROGRAM_ID);
    let destination = params.destination;
    if (!destination) {
      if (!params.destinationOwner) {
        throw new Error("transfer requires destination or destinationOwner");
      }
      destination = getAssociatedTokenAddressSync(
        params.mint,
        params.destinationOwner,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    }
    const ix = await createTransferCheckedWithTransferHookInstruction(
      this.connection,
      source,
      params.mint,
      destination,
      owner.publicKey,
      BigInt(params.amount),
      params.decimals,
      [],
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const signers = owner.publicKey.equals(this.payer.publicKey) ? [this.payer] : [this.payer, owner];
    return sendAndConfirmTransaction(this.connection, new Transaction().add(ix), signers, CONFIRM);
  }

  /** Read a mint's policy, or `null` if it has none. */
  async getPolicy(mint: PublicKey): Promise<PolicyView | null> {
    const acc = await this.program.account.policyConfig.fetchNullable(this.policy(mint));
    if (!acc) return null;
    return {
      mint: acc.mint,
      authority: acc.authority,
      allowlistEnabled: acc.allowlistEnabled,
      blocklistEnabled: acc.blocklistEnabled,
      maxTransferAmount: BigInt(acc.maxTransferAmount.toString()),
      allowConfidential: acc.allowConfidential,
    };
  }

  async isAllowlisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.allowEntry.fetchNullable(this.allowEntry(mint, wallet))) !== null;
  }

  async isBlocklisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.blockEntry.fetchNullable(this.blockEntry(mint, wallet))) !== null;
  }
}
