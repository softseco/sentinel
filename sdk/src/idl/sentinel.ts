/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sentinel.json`.
 */
export type Sentinel = {
  "address": "4Lr94hphpGHq2VY6CRC5Yxq6k3gs9nSSzsh479hVU1Xw",
  "metadata": {
    "name": "sentinel",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Programmable compliance for Token-2022 tokenized assets, built on Transfer Hooks."
  },
  "instructions": [
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
          "signer": true
        },
        {
          "name": "mint"
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
          "signer": true
        },
        {
          "name": "mint"
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
          "signer": true
        },
        {
          "name": "mint"
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
          "signer": true
        },
        {
          "name": "mint"
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
      "name": "transferHook",
      "docs": [
        "Invoked by Token-2022 on every transfer. Enforces the mint's policy."
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
