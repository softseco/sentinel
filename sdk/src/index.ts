// SPDX-License-Identifier: Apache-2.0
//
// @softseco/sentinel — TypeScript SDK for the Sentinel compliance program.
export { SentinelClient, MAX_LIST_UPDATES_PER_TX } from "./client";
export type { PolicyView, SentinelEvent } from "./client";
export {
  META_LIST_SEED,
  POLICY_SEED,
  ALLOW_SEED,
  BLOCK_SEED,
  PENDING_AUTHORITY_SEED,
  metaListPda,
  policyPda,
  allowEntryPda,
  blockEntryPda,
  pendingAuthorityPda,
} from "./pdas";
export type { Sentinel } from "./idl/sentinel";
