// SPDX-License-Identifier: Apache-2.0
import { PublicKey } from "@solana/web3.js";

export const META_LIST_SEED = Buffer.from("extra-account-metas");
export const POLICY_SEED = Buffer.from("policy");
export const ALLOW_SEED = Buffer.from("allow");
export const BLOCK_SEED = Buffer.from("block");

/** PDA that stores a mint's ExtraAccountMetaList (`["extra-account-metas", mint]`). */
export const metaListPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([META_LIST_SEED, mint.toBuffer()], programId)[0];

/** A mint's policy config PDA (`["policy", mint]`). */
export const policyPda = (mint: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([POLICY_SEED, mint.toBuffer()], programId)[0];

/** A wallet's allowlist entry PDA for a mint (`["allow", mint, wallet]`). */
export const allowEntryPda = (mint: PublicKey, wallet: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([ALLOW_SEED, mint.toBuffer(), wallet.toBuffer()], programId)[0];

/** A wallet's blocklist entry PDA for a mint (`["block", mint, wallet]`). */
export const blockEntryPda = (mint: PublicKey, wallet: PublicKey, programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([BLOCK_SEED, mint.toBuffer(), wallet.toBuffer()], programId)[0];
