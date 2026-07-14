// SPDX-License-Identifier: Apache-2.0
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Signer,
  SystemProgram,
  Transaction,
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
import { allowEntryPda, blockEntryPda, metaListPda, policyPda } from "./pdas";

const CONFIRM = { commitment: "confirmed" as const };

/** A decoded view of a mint's compliance policy. */
export interface PolicyView {
  mint: PublicKey;
  authority: PublicKey;
  allowlistEnabled: boolean;
  blocklistEnabled: boolean;
  maxTransferAmount: bigint;
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
  }): Promise<string> {
    return this.program.methods
      .initializePolicy(params.allowlist, params.blocklist, new BN(params.maxTransferAmount.toString()))
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
  }): Promise<string> {
    return this.program.methods
      .updatePolicy(params.allowlist, params.blocklist, new BN(params.maxTransferAmount.toString()))
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
    };
  }

  async isAllowlisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.allowEntry.fetchNullable(this.allowEntry(mint, wallet))) !== null;
  }

  async isBlocklisted(mint: PublicKey, wallet: PublicKey): Promise<boolean> {
    return (await this.program.account.blockEntry.fetchNullable(this.blockEntry(mint, wallet))) !== null;
  }
}
