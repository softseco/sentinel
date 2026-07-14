# @softseco/sentinel

TypeScript SDK for **Sentinel** — programmable compliance for Token-2022 tokenized assets, built on
the Transfer Hook extension. Create a compliant mint, set a policy (allowlist, blocklist, transfer
limit), manage entries, and move tokens through the hook — in a handful of async calls.

> **Status: pre-alpha, in active development.** Built by Softseco.

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
- `initializePolicy({ mint, allowlist, blocklist, maxTransferAmount })` / `updatePolicy(...)`
- `initializeExtraAccountMetaList(mint)`
- `addToAllowlist(mint, wallet)` / `removeFromAllowlist(mint, wallet)`
- `addToBlocklist(mint, wallet)` / `removeFromBlocklist(mint, wallet)`
- `transfer({ mint, amount, decimals, destinationOwner?, destination?, owner?, source? })`
- `getPolicy(mint)`, `isAllowlisted(mint, wallet)`, `isBlocklisted(mint, wallet)`
- PDA helpers: `policy`, `metaList`, `allowEntry`, `blockEntry`

## License

Apache-2.0.
