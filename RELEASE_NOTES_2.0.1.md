Sentinel 2.0.1 — first deployment.

The program now has a real program id and runs on Solana devnet:

  5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD
  https://explorer.solana.com/address/5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD?cluster=devnet

The previous id was a local build artefact whose keypair is gone and which was never deployed, so the
program was rebuilt under a fresh keypair. `declare_id!`, `Anchor.toml` and the SDK's bundled IDL carry
the new id. Program behaviour is unchanged from 2.0.0; 15 integration tests pass.
