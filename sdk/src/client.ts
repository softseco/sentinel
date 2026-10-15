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
  AuthorityType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  unpackAccount,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha2";
import idl from "./idl/sentinel.json";
import type { Sentinel } from "./idl/sentinel";
import {
  allowEntryPda,
  blockEntryPda,
  freezeAuthorityPda,
  metaListPda,
  pendingAuthorityPda,
  policyPda,
} from "./pdas";

const CONFIRM = { commitment: "confirmed" as const };

/**
 * How many allow or block list changes the batch helpers put in one transaction. Each one creates
 * or closes an account, so this stays well inside the transaction size and compute limits.
 */
export const MAX_LIST_UPDATES_PER_TX = 8;

/** How many freezes or thaws the wallet helpers put in one transaction. */
export const MAX_FREEZES_PER_TX = 8;

/**
 * Why a wallet was blocked or unblocked, or a token account frozen or thawed. Sentinel does not
 * interpret either field; both go into the `enforcementAction` event.
 *
 * - `reasonCode`: the issuer's own code, 0 to 65535. `ENFORCEMENT_REASONS` is a suggested set.
 * - `caseRef`: 32 bytes pointing to the issuer's case file. Use `caseRef(caseId, salt)`, so the
 *   chain holds a hash and no personal data, and only someone with the salt can match it.
 */
export interface Enforcement {
  reasonCode: number;
  caseRef: Uint8Array | number[];
}

/** A suggested set of reason codes. Issuers may use their own; Sentinel only records the number. */
export const ENFORCEMENT_REASONS = {
  unspecified: 0,
  sanctions: 1,
  courtOrder: 2,
  authorityRequest: 3,
  fraud: 4,
  stolenFunds: 5,
  internalReview: 6,
  /** For an unblock or a thaw: the case is closed. */
  caseClosed: 7,
} as const;

/**
 * A 32-byte case reference for `Enforcement.caseRef`: SHA-256 of `salt` followed by `caseId`.
 * Keep the salt private: with it, the issuer (or its supervisor) can show which case an on-chain
 * action belongs to; without it, nobody can guess the case number from the hash.
 */
export function caseRef(caseId: string, salt: string | Uint8Array): Uint8Array {
  const saltBytes = typeof salt === "string" ? Buffer.from(salt, "utf8") : Buffer.from(salt);
  return sha256(Buffer.concat([saltBytes, Buffer.from(caseId, "utf8")]));
}

/** A token account of a mint and whether it is frozen. */
export interface TokenAccountView {
  address: PublicKey;
  owner: PublicKey;
  amount: bigint;
  frozen: boolean;
}

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
  /** Sentinel's freeze-authority address for `mint` (2.2). */
  freezeAuthority(mint: PublicKey): PublicKey {
    return freezeAuthorityPda(mint, this.programId);
  }

  private get connection() {
    return this.provider.connection;
  }
  private get payer(): Signer {
    return (this.provider.wallet as unknown as { payer: Signer }).payer;
  }

  /**
   * Create a Token-2022 mint whose transfer hook is Sentinel. Signs with `mint`.
   *
   * `freezeAuthority: "sentinel"` names Sentinel's freeze-authority address, so the policy
   * authority can freeze and thaw token accounts through Sentinel. The default is no freeze
   * authority, as before 2.2; a freeze authority cannot be added to a mint created without one.
   */
  async createCompliantMint(params: {
    mint: Keypair;
    decimals: number;
    mintAuthority?: PublicKey;
    freezeAuthority?: PublicKey | "sentinel" | null;
  }): Promise<PublicKey> {
    const authority = params.mintAuthority ?? this.payer.publicKey;
    const freezeAuthority =
      params.freezeAuthority === "sentinel"
        ? this.freezeAuthority(params.mint.publicKey)
        : (params.freezeAuthority ?? null);
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
        freezeAuthority,
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

  /** `block_wallet` (`add_to_blocklist` that records why), signed by `authority`. */
  blockWalletInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    return this.program.methods
      .blockWallet(reasonCode, ref)
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** `unblock_wallet` (`remove_from_blocklist` that records why), signed by `authority`. */
  unblockWalletInstruction(params: {
    mint: PublicKey;
    wallet: PublicKey;
    enforcement: Enforcement;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint, wallet } = params;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    return this.program.methods
      .unblockWallet(reasonCode, ref)
      .accountsPartial({
        authority: params.authority ?? this.payer.publicKey,
        mint,
        policyConfig: this.policy(mint),
        wallet,
        blockEntry: this.blockEntry(mint, wallet),
      })
      .instruction();
  }

  /** `freeze_token_account` or `thaw_token_account` for one token account, signed by `authority`. */
  freezeInstruction(params: {
    mint: PublicKey;
    tokenAccount: PublicKey;
    enforcement: Enforcement;
    thaw?: boolean;
    authority?: PublicKey;
  }): Promise<TransactionInstruction> {
    const { mint } = params;
    const [reasonCode, ref] = enforcementArgs(params.enforcement);
    const accounts = {
      authority: params.authority ?? this.payer.publicKey,
      mint,
      policyConfig: this.policy(mint),
      tokenAccount: params.tokenAccount,
      freezeAuthority: this.freezeAuthority(mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    };
    return params.thaw
      ? this.program.methods.thawTokenAccount(reasonCode, ref).accountsPartial(accounts).instruction()
      : this.program.methods.freezeTokenAccount(reasonCode, ref).accountsPartial(accounts).instruction();
  }

  // ---- Enforcement (provider wallet as the policy authority) ----

  /** Blocklist `wallet`, recording why. */
  async blockWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.blockWalletInstruction({ mint, wallet, enforcement })]);
  }

  /** Remove `wallet` from the blocklist, recording why. */
  async unblockWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.unblockWalletInstruction({ mint, wallet, enforcement })]);
  }

  /** Freeze one token account. The mint's freeze authority must be `freezeAuthority(mint)`. */
  async freezeTokenAccount(mint: PublicKey, tokenAccount: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.freezeInstruction({ mint, tokenAccount, enforcement })]);
  }

  /** Thaw one token account. */
  async thawTokenAccount(mint: PublicKey, tokenAccount: PublicKey, enforcement: Enforcement): Promise<string> {
    return this.send([await this.freezeInstruction({ mint, tokenAccount, enforcement, thaw: true })]);
  }

  /**
   * Freeze every token account of `mint` that `owner` holds and that is not frozen yet, in
   * batches of `MAX_FREEZES_PER_TX`. A wallet can hold several accounts of one mint; the
   * blocklist covers the wallet, but freezing is per account. Returns the signatures.
   */
  async freezeWallet(mint: PublicKey, owner: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, owner)).filter((a) => !a.frozen);
    return this.freezeBatch(mint, accounts.map((a) => a.address), enforcement, false);
  }

  /** Thaw every frozen token account of `mint` that `owner` holds. */
  async thawWallet(mint: PublicKey, owner: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, owner)).filter((a) => a.frozen);
    return this.freezeBatch(mint, accounts.map((a) => a.address), enforcement, true);
  }

  /**
   * Blocklist `wallet` and freeze its token accounts of `mint`. The block and the first
   * `MAX_FREEZES_PER_TX - 1` freezes go in one transaction, so the wallet is never blocked
   * without its first accounts frozen too. Fails if the wallet is already blocklisted; use
   * `freezeWallet` then. Returns the signatures.
   */
  async blockAndFreezeWallet(mint: PublicKey, wallet: PublicKey, enforcement: Enforcement): Promise<string[]> {
    const accounts = (await this.tokenAccountsOf(mint, wallet)).filter((a) => !a.frozen).map((a) => a.address);
    const first = accounts.slice(0, MAX_FREEZES_PER_TX - 1);
    const ixs = [
      await this.blockWalletInstruction({ mint, wallet, enforcement }),
      ...(await Promise.all(first.map((tokenAccount) => this.freezeInstruction({ mint, tokenAccount, enforcement })))),
    ];
    const signatures = [await this.send(ixs)];
    signatures.push(...(await this.freezeBatch(mint, accounts.slice(first.length), enforcement, false)));
    return signatures;
  }

  /**
   * Hand the mint's freeze authority to Sentinel, so the policy authority can freeze and thaw
   * through it. `currentFreezeAuthority` must sign. Works only on a mint that has a freeze
   * authority; one created without can never get one.
   */
  setSentinelAsFreezeAuthority(mint: PublicKey, currentFreezeAuthority: Signer): Promise<string> {
    const ix = createSetAuthorityInstruction(
      mint,
      currentFreezeAuthority.publicKey,
      AuthorityType.FreezeAccount,
      this.freezeAuthority(mint),
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    const extra = currentFreezeAuthority.publicKey.equals(this.payer.publicKey) ? [] : [currentFreezeAuthority];
    return this.send([ix], extra);
  }

  /** Every token account of `mint` held by `owner`, with its state. */
  async tokenAccountsOf(mint: PublicKey, owner: PublicKey): Promise<TokenAccountView[]> {
    const { value } = await this.connection.getTokenAccountsByOwner(owner, { mint }, "confirmed");
    return value.map(({ pubkey, account }) => {
      const parsed = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
      return { address: pubkey, owner: parsed.owner, amount: parsed.amount, frozen: parsed.isFrozen };
    });
  }

  /** Whether a token account is frozen. */
  async isFrozen(tokenAccount: PublicKey): Promise<boolean> {
    return (await getAccount(this.connection, tokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID)).isFrozen;
  }

  private async freezeBatch(
    mint: PublicKey,
    tokenAccounts: PublicKey[],
    enforcement: Enforcement,
    thaw: boolean,
  ): Promise<string[]> {
    const signatures: string[] = [];
    for (let i = 0; i < tokenAccounts.length; i += MAX_FREEZES_PER_TX) {
      const chunk = tokenAccounts.slice(i, i + MAX_FREEZES_PER_TX);
      const ixs = await Promise.all(
        chunk.map((tokenAccount) => this.freezeInstruction({ mint, tokenAccount, enforcement, thaw })),
      );
      signatures.push(await this.send(ixs));
    }
    return signatures;
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

/** The program's arguments for an `Enforcement`, checked. */
function enforcementArgs(e: Enforcement): [number, number[]] {
  if (!Number.isInteger(e.reasonCode) || e.reasonCode < 0 || e.reasonCode > 0xffff) {
    throw new Error(`reasonCode must be an integer from 0 to 65535, got ${e.reasonCode}`);
  }
  const ref = Array.from(e.caseRef);
  if (ref.length !== 32) throw new Error(`caseRef must be 32 bytes, got ${ref.length}`);
  return [e.reasonCode, ref];
}
