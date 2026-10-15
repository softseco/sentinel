/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sentinel.json`.
 */
export type Sentinel = {
  "address": "5fH1jj6XeZC96jPCxKiSb2onAXcs7f4rMeqMmSsP6puD",
  "metadata": {
    "name": "sentinel",
    "version": "2.2.0",
    "spec": "0.1.0",
    "description": "Programmable compliance for Token-2022 tokenized assets, built on Transfer Hooks."
  },
  "instructions": [
    {
      "name": "acceptAuthority",
      "docs": [
        "Complete the handover: the proposed authority signs and becomes the policy authority."
      ],
      "discriminator": [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160
      ],
      "accounts": [
        {
          "name": "newAuthority",
          "signer": true
        },
        {
          "name": "previousAuthority",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "addToAllowlist",
      "docs": [
        "Add a wallet to a mint's allowlist by creating its `AllowEntry` PDA."
      ],
      "discriminator": [
        149,
        143,
        78,
        134,
        241,
        244,
        7,
        56
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "allowEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "addToBlocklist",
      "docs": [
        "Add a wallet to a mint's blocklist by creating its `BlockEntry` PDA."
      ],
      "discriminator": [
        201,
        138,
        75,
        216,
        252,
        201,
        26,
        106
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "blockWallet",
      "docs": [
        "`add_to_blocklist`, recording why: also emits `EnforcementAction` with the issuer's",
        "`reason_code` and `case_ref` (for example a salted hash of its case number)."
      ],
      "discriminator": [
        132,
        75,
        123,
        1,
        97,
        186,
        159,
        194
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "cancelAuthorityTransfer",
      "docs": [
        "Withdraw a pending proposal. Only the current authority may call this."
      ],
      "discriminator": [
        94,
        131,
        125,
        184,
        183,
        24,
        125,
        229
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "freezeTokenAccount",
      "docs": [
        "Freeze one token account of the mint: Token-2022 then refuses every instruction on it",
        "(transfers in and out, burns, approvals, confidential deposits, transfers and withdrawals)",
        "until it is thawed. Only the policy authority may call this, and only for a mint whose",
        "freeze authority is Sentinel's freeze-authority address for that mint."
      ],
      "discriminator": [
        138,
        168,
        178,
        109,
        205,
        224,
        209,
        93
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "docs": [
            "program, mint, current state); Sentinel only reads its owner for the event."
          ],
          "writable": true
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initializeExtraAccountMetaList",
      "docs": [
        "Create and initialize the `ExtraAccountMetaList` PDA for `mint`, declaring",
        "the accounts the hook needs on every transfer: the policy config, the",
        "sender's and recipient's blocklist entries, and the recipient's allowlist",
        "entry (all resolved from the transfer's own accounts)."
      ],
      "discriminator": [
        92,
        197,
        174,
        197,
        41,
        124,
        19,
        3
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializePolicy",
      "docs": [
        "Create the mint's `PolicyConfig`. The signer becomes its authority."
      ],
      "discriminator": [
        9,
        186,
        86,
        225,
        129,
        162,
        231,
        56
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "allowlistEnabled",
          "type": "bool"
        },
        {
          "name": "blocklistEnabled",
          "type": "bool"
        },
        {
          "name": "maxTransferAmount",
          "type": "u64"
        },
        {
          "name": "allowConfidential",
          "type": "bool"
        }
      ]
    },
    {
      "name": "proposeAuthority",
      "docs": [
        "Start handing the policy to `new_authority` (for example a multisig vault). Nothing",
        "changes until `new_authority` accepts, so a mistyped address cannot lock the policy."
      ],
      "discriminator": [
        20,
        148,
        236,
        198,
        76,
        119,
        99,
        142
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "removeFromAllowlist",
      "docs": [
        "Remove a wallet from a mint's allowlist by closing its `AllowEntry` PDA."
      ],
      "discriminator": [
        45,
        46,
        214,
        56,
        189,
        77,
        242,
        227
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "allowEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "removeFromBlocklist",
      "docs": [
        "Remove a wallet from a mint's blocklist by closing its `BlockEntry` PDA."
      ],
      "discriminator": [
        132,
        125,
        30,
        120,
        139,
        22,
        210,
        90
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "thawTokenAccount",
      "docs": [
        "Thaw a token account frozen with `freeze_token_account` (or by any earlier holder of the",
        "mint's freeze authority). Same rules as freezing."
      ],
      "discriminator": [
        199,
        172,
        96,
        93,
        244,
        252,
        137,
        171
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "docs": [
            "program, mint, current state); Sentinel only reads its owner for the event."
          ],
          "writable": true
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "transferHook",
      "docs": [
        "Invoked by Token-2022 on every transfer. Enforces the mint's policy.",
        "",
        "A refusal emits `TransferRefused` before returning the error, so indexers can read the",
        "reason from the failed transaction's logs."
      ],
      "discriminator": [
        220,
        57,
        220,
        152,
        126,
        125,
        97,
        168
      ],
      "accounts": [
        {
          "name": "sourceToken"
        },
        {
          "name": "mint"
        },
        {
          "name": "destinationToken"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "sourceBlock"
        },
        {
          "name": "destBlock"
        },
        {
          "name": "allowEntry"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unblockWallet",
      "docs": [
        "`remove_from_blocklist`, recording why (`EnforcementAction`)."
      ],
      "discriminator": [
        123,
        52,
        119,
        61,
        139,
        43,
        126,
        73
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "updateExtraAccountMetaList",
      "docs": [
        "Rewrite a mint's `ExtraAccountMetaList` to the current list, growing the account if",
        "needed. Mints initialized before 2.1 run this once so the hook also receives the transfer",
        "authority's blocklist entry. The list's content is fixed by the program; only the policy",
        "authority may trigger the rewrite, and it pays for any extra rent."
      ],
      "discriminator": [
        44,
        125,
        141,
        226,
        97,
        179,
        166,
        96
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "updatePolicy",
      "docs": [
        "Update the mint's policy. Only the policy authority may call this."
      ],
      "discriminator": [
        212,
        245,
        246,
        7,
        163,
        151,
        18,
        57
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "allowlistEnabled",
          "type": "bool"
        },
        {
          "name": "blocklistEnabled",
          "type": "bool"
        },
        {
          "name": "maxTransferAmount",
          "type": "u64"
        },
        {
          "name": "allowConfidential",
          "type": "bool"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "allowEntry",
      "discriminator": [
        3,
        29,
        6,
        254,
        2,
        209,
        219,
        245
      ]
    },
    {
      "name": "blockEntry",
      "discriminator": [
        160,
        179,
        255,
        246,
        122,
        148,
        254,
        143
      ]
    },
    {
      "name": "pendingAuthority",
      "discriminator": [
        108,
        91,
        208,
        174,
        216,
        189,
        207,
        93
      ]
    },
    {
      "name": "policyConfig",
      "discriminator": [
        219,
        7,
        79,
        84,
        175,
        51,
        148,
        146
      ]
    }
  ],
  "events": [
    {
      "name": "authorityTransferCancelled",
      "discriminator": [
        31,
        228,
        187,
        148,
        20,
        99,
        237,
        48
      ]
    },
    {
      "name": "authorityTransferProposed",
      "discriminator": [
        103,
        244,
        27,
        116,
        177,
        4,
        100,
        119
      ]
    },
    {
      "name": "authorityTransferred",
      "discriminator": [
        245,
        109,
        179,
        54,
        135,
        92,
        22,
        64
      ]
    },
    {
      "name": "enforcementAction",
      "discriminator": [
        20,
        159,
        238,
        27,
        33,
        176,
        40,
        223
      ]
    },
    {
      "name": "listEntryAdded",
      "discriminator": [
        254,
        152,
        108,
        37,
        231,
        44,
        230,
        119
      ]
    },
    {
      "name": "listEntryRemoved",
      "discriminator": [
        157,
        60,
        145,
        12,
        47,
        48,
        254,
        47
      ]
    },
    {
      "name": "metaListUpdated",
      "discriminator": [
        170,
        131,
        210,
        101,
        188,
        39,
        126,
        26
      ]
    },
    {
      "name": "policyInitialized",
      "discriminator": [
        102,
        184,
        59,
        178,
        235,
        69,
        251,
        181
      ]
    },
    {
      "name": "policyUpdated",
      "discriminator": [
        225,
        112,
        112,
        67,
        95,
        236,
        245,
        161
      ]
    },
    {
      "name": "transferRefused",
      "discriminator": [
        28,
        112,
        75,
        245,
        67,
        66,
        237,
        197
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "recipientNotAllowlisted",
      "msg": "Recipient is not on the allowlist for this mint"
    },
    {
      "code": 6001,
      "name": "transferExceedsLimit",
      "msg": "Transfer amount exceeds the policy limit"
    },
    {
      "code": 6002,
      "name": "senderBlocked",
      "msg": "Sender is blocklisted for this mint"
    },
    {
      "code": 6003,
      "name": "recipientBlocked",
      "msg": "Recipient is blocklisted for this mint"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "Only the policy authority may perform this action"
    },
    {
      "code": 6005,
      "name": "confidentialAmountNotEnforceable",
      "msg": "This mint sets a transfer limit, which cannot be enforced on a confidential transfer; set allow_confidential on the policy to permit them"
    },
    {
      "code": 6006,
      "name": "authorityBlocked",
      "msg": "The transfer authority (a delegate of the source account) is blocklisted for this mint"
    },
    {
      "code": 6007,
      "name": "invalidAuthority",
      "msg": "The new authority must be a real address and differ from the current one"
    },
    {
      "code": 6008,
      "name": "freezeAuthorityNotSentinel",
      "msg": "The mint's freeze authority is not Sentinel's freeze-authority address for this mint"
    }
  ],
  "types": [
    {
      "name": "allowEntry",
      "docs": [
        "An allowlist entry: its existence means `wallet` may receive `mint`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "authorityTransferCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorityTransferProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorityTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "previousAuthority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "blockEntry",
      "docs": [
        "A blocklist entry: its existence means `wallet` may neither send nor receive `mint`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "enforcementAction",
      "docs": [
        "Emitted by `block_wallet`, `unblock_wallet`, `freeze_token_account` and `thaw_token_account`:",
        "what was done, to whom, and the issuer's reason. Sentinel does not interpret `reason_code`;",
        "`case_ref` points to the issuer's own case file (for example a salted hash of its case number),",
        "so no personal data needs to go on-chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "docs": [
              "The blocked or unblocked wallet, or the owner of the frozen or thawed token account."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "docs": [
              "The frozen or thawed token account; the default address for a block or unblock."
            ],
            "type": "pubkey"
          },
          {
            "name": "action",
            "type": {
              "defined": {
                "name": "enforcementKind"
              }
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "enforcementKind",
      "docs": [
        "What an `EnforcementAction` did."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "block"
          },
          {
            "name": "unblock"
          },
          {
            "name": "freeze"
          },
          {
            "name": "thaw"
          }
        ]
      }
    },
    {
      "name": "listEntryAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "list",
            "type": {
              "defined": {
                "name": "listKind"
              }
            }
          }
        ]
      }
    },
    {
      "name": "listEntryRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "list",
            "type": {
              "defined": {
                "name": "listKind"
              }
            }
          }
        ]
      }
    },
    {
      "name": "listKind",
      "docs": [
        "Which list an entry belongs to."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "allow"
          },
          {
            "name": "block"
          }
        ]
      }
    },
    {
      "name": "metaListUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "entries",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pendingAuthority",
      "docs": [
        "A proposed handover of a mint's policy authority, waiting for `new_authority` to accept."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policyConfig",
      "docs": [
        "Per-mint compliance policy: which rules are active and their parameters."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "docs": [
              "Permit confidential transfers on a mint that also sets",
              "`max_transfer_amount`. The limit cannot be enforced on an encrypted",
              "amount, so the issuer opts in to that gap explicitly. Irrelevant when no",
              "limit is set, because there is then nothing to enforce."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policyInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "policyUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "transferRefused",
      "docs": [
        "Emitted by the hook just before it refuses a transfer. The transaction fails, but its logs",
        "(and this event) stay readable. `error_code` is the `SentinelError` code, e.g. 6003."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "sourceOwner",
            "type": "pubkey"
          },
          {
            "name": "destinationOwner",
            "type": "pubkey"
          },
          {
            "name": "transferAuthority",
            "type": "pubkey"
          },
          {
            "name": "confidential",
            "type": "bool"
          },
          {
            "name": "errorCode",
            "type": "u32"
          }
        ]
      }
    }
  ]
};
