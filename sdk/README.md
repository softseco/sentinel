# @softseco/sentinel

TypeScript SDK for **Sentinel** — programmable compliance for Token-2022 tokenized assets, built on
the Transfer Hook extension. Create a compliant mint, set a policy (allowlist, blocklist, transfer
limit), manage entries, and move tokens through the hook — in a handful of async calls.

> **Status: `v2.1.0`.** Stable API, self-audited, not independently audited. The program is deployed
> on Solana devnet at `5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD`. Built by Softseco.

## Install

```bash
npm install @softseco/sentinel
```

Peers you'll already have in a Solana app: `@coral-xyz/anchor`, `@solana/web3.js`,
`@solana/spl-token`.

## Usage

```ts
import { AnchorProvider } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SentinelClient } from "@softseco/sentinel";

const client = new SentinelClient(provider); // AnchorProvider

// 1. Create a Token-2022 mint whose transfer hook is Sentinel
const mint = Keypair.generate();
await client.createCompliantMint({ mint, decimals: 0 });

// 2. Set a policy: allowlist on, no blocklist, max 1000 per transfer
await client.initializePolicy({
  mint: mint.publicKey,
  allowlist: true,
  blocklist: false,
  maxTransferAmount: 1000n,
  allowConfidential: false, // default — see "Confidential transfers" below
});

// 3. Register the hook's extra accounts
await client.initializeExtraAccountMetaList(mint.publicKey);

// 4. Allowlist a recipient, then transfer to them (blocked otherwise)
await client.addToAllowlist(mint.publicKey, recipient);
await client.transfer({ mint: mint.publicKey, destinationOwner: recipient, amount: 100n, decimals: 0 });

// Reads
await client.getPolicy(mint.publicKey);
await client.isAllowlisted(mint.publicKey, recipient);
await client.isBlocklisted(mint.publicKey, someWallet);
```

## API

`SentinelClient(provider)` exposes:

- `createCompliantMint({ mint, decimals, mintAuthority? })`
- `initializePolicy({ mint, allowlist, blocklist, maxTransferAmount, allowConfidential? })` /
  `updatePolicy(...)` — `allowConfidential` defaults to `false`
- `initializeExtraAccountMetaList(mint)`
- `addToAllowlist(mint, wallet)` / `removeFromAllowlist(mint, wallet)`
- `addToBlocklist(mint, wallet)` / `removeFromBlocklist(mint, wallet)`
- `transfer({ mint, amount, decimals, destinationOwner?, destination?, owner?, source? })`
- `getPolicy(mint)`, `isAllowlisted(mint, wallet)`, `isBlocklisted(mint, wallet)`
- PDA helpers: `policy`, `metaList`, `allowEntry`, `blockEntry`, `pendingAuthority`

Since 2.1:

- Batch list updates, eight per transaction: `addToAllowlistBatch(mint, wallets)`,
  `removeFromAllowlistBatch`, `addToBlocklistBatch`, `removeFromBlocklistBatch`
- Authority handover: `proposeAuthority(mint, newAuthority)`, `acceptAuthority(mint, newAuthoritySigner)`,
  `cancelAuthorityTransfer(mint)`, `getPendingAuthority(mint)`
- `updateExtraAccountMetaList(mint)`: run once for a mint set up before 2.1, so the blocklist also
  covers delegates
- Events: `getEvents(signature)` and `parseEvents(logs)` decode `transferRefused`, `policyUpdated`,
  `listEntryAdded`, `listEntryRemoved`, `authorityTransferred` and the rest, including from the logs
  of a failed transfer
- Instruction builders, with the authority as a parameter: `updatePolicyInstruction`,
  `listInstruction`, `proposeAuthorityInstruction`, `acceptAuthorityInstruction`,
  `cancelAuthorityTransferInstruction`, `updateExtraAccountMetaListInstruction`

## Policy authority held by a multisig

The `SentinelClient` methods sign with the provider wallet. When the policy authority is a
multisig, build the instruction with the multisig's address as `authority` and propose it there:

```ts
// 1. Today's authority proposes the multisig vault; nothing changes yet.
await client.proposeAuthority(mint, vault);

// 2. The multisig accepts: put this instruction in a multisig transaction and execute it.
const accept = await client.acceptAuthorityInstruction(mint, vault, currentAuthority);

// 3. From then on, every change is a multisig transaction, for example:
const block = await client.listInstruction({ mint, wallet, list: "block", action: "add", authority: vault });
```

The handover takes two steps so that a mistyped address cannot lock the policy: until the new
authority signs `accept`, the old one stays in charge and can `cancelAuthorityTransfer`.

## Confidential transfers

Token-2022 invokes a transfer hook for a **confidential** transfer with `amount = u64::MAX`, because
the real amount is encrypted and never reaches the hook. A per-transfer limit therefore cannot be
checked against it.

Sentinel does not quietly skip the limit — that would leave a policy that reads as enforced but is
not. On a mint that sets `maxTransferAmount`, a confidential transfer is refused with
`ConfidentialAmountNotEnforceable` (error 6005) unless the policy sets `allowConfidential: true`,
which is the issuer accepting, explicitly, that the limit does not reach those transfers. With
`maxTransferAmount: 0` there is no limit to be unenforceable, so the flag is irrelevant.

The allowlist and blocklist work on **addresses**, which stay public, so they apply to confidential
transfers exactly as they do to public ones. To watch the amounts of confidential transfers, give
the mint an auditor key: the auditor decrypts every amount off-chain (see
`@softseco/confidential-transfers`). `getPolicy(mint)` returns `allowConfidential` alongside
the other fields.

## License

Apache-2.0.
