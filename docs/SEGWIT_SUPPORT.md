# Segwit / Taproot support in Gravity

This document was written in Phase-2 days when the relayer auto-stripped
witness data and the covenant was indifferent to Taker input type. Phase 3
changed that: to close the attacker-chosen-`outputOffset` bypass (audit 03
finding C2), the covenant now enforces a **fixed tx layout** on the Taker
payment. That locked down the byte offset of output[0] but narrowed the
acceptable wallet format.

**Read this before broadcasting any BTC payment against a post-Phase-3
covenant.** Using an unsupported wallet will destroy your BTC — the
covenant rejects finalize and there is no refund path.

## Taker — supported wallet formats

The Taker's BTC payment must be:

- **Exactly 1 input**, from a UTXO controlled by the Taker's privkey.
- **Input type**: one of
  - **P2WPKH** (`bc1q…`) — native segwit v0. Empty scriptSig after
    witness-strip. outputOffset = 47 bytes.
  - **P2TR** (`bc1p…`) — taproot / segwit v1. Empty scriptSig after
    witness-strip. outputOffset = 47 bytes.
  - **P2SH-P2WPKH** (`3…`) — wrapped segwit. Has a fixed 23-byte
    scriptSig containing the P2WPKH redeem script push
    (`0x16 0x00 0x14 <20B pkh>`). outputOffset = 70 bytes.
  The covenant branches on the scriptSig length byte and picks the
  matching offset.
- **Output[0] is the Maker's payment**, of whatever type the Maker
  specified (`btcReceiveType` + `btcReceiveHash`). The Maker can accept
  any of P2PKH / P2WPKH / P2SH / P2TR — the Maker-output type is
  independent of the Taker-input type.
- **Optional output[1] is change** to the Taker.
- **More than ~252 outputs total** are rejected (multi-byte `outputCount`
  varint).

### Unsupported today

- **Legacy P2PKH (`1...`)** — scriptSig includes signature + pubkey and
  varies in length (typically 106-108 bytes but not fixed). Requires full
  varint parsing inside the covenant; not planned for the prototype.
- **P2WSH / P2SH-P2WSH** — variable-length witness scripts; same issue
  as legacy for structural parsing.
- **Multi-input txs** — any Taker tx that draws from more than one UTXO,
  regardless of format, is rejected. Consolidate first.

### How to tell if your wallet works

Check the address format you generate as the input UTXO:

| Address starts with | Type | Works? | `--input-type` |
|---|---|---|---|
| `bc1q` (42 chars) | P2WPKH | ✅ yes | `p2wpkh` (default) |
| `bc1p` (62 chars) | P2TR | ✅ yes | `p2wpkh` (same layout post-strip) |
| `3` | P2SH-P2WPKH | ✅ yes | `p2sh-p2wpkh` |
| `3` | other P2SH variants | ❌ no | — |
| `1` | legacy P2PKH | ❌ no | — |
| `bc1q` (62 chars) | P2WSH | ❌ no | — |

Note: a `3…` address is only P2SH-P2WPKH if your wallet advertises
"p2sh-segwit" / "wrapped segwit" / "SegWit compatibility" mode. Other
`3…` variants (multisig, arbitrary P2SH redeem scripts) use different
scriptSig shapes and will not satisfy the covenant's structural check.

Use `node relayer/src/cli.js btc-keygen --out taker-keys.json` to get
addresses in all supported formats. Fund the appropriate address for
your chosen `--input-type`.

## Maker — supported receive formats

The Maker can choose any of the four output types for their
`btcReceiveType`. All are handled by the covenant's payment-verification
branch when the generator runs with `--btc-type all`, or the single-type
variant when built with `--btc-type p2wpkh` (etc.).

| Maker receive type | `--btc-type` arg | Taker pays to |
|---|---|---|
| P2PKH | `p2pkh` | `1...` |
| P2WPKH | `p2wpkh` | `bc1q...` (42 chars) |
| P2SH | `p2sh` | `3...` |
| P2TR | `p2tr` | `bc1p...` |
| any | `all` | per `btcReceiveType` int |

Single-type variants produce a slightly smaller covenant (~6 fewer
opcodes); use multi-type only if you want to support multiple Makers on
one template.

## Witness-stripping stays part of the pipeline

The covenant computes `hash256(rawTx) == txid` to derive the Merkle leaf.
For segwit txs, the full wire serialization includes marker/flag/witness
bytes, and `hash256` of that yields `wtxid`, not `txid`. The relayer's
`fetch-spv-proof` auto-strips witness data before emitting the proof so
that `hash256(stripped) == txid` holds.

Covenant-side: it only ever sees the stripped serialization.

## Why the constraint exists

See [`docs/audits/03-radiantscript-covenant.md`](./audits/03-radiantscript-covenant.md)
finding C2 for the attack that motivates the fixed layout. Briefly: if
the Taker could supply an arbitrary `outputOffset`, they could point it
at an `OP_RETURN` data push containing the exact pattern
`<8B value> 19 76a914 <Maker pkh> 88ac`. The "payment" would be embedded
as inert data inside some real BTC tx, never actually paying the Maker.
The fixed layout forces output[0] to be the real payment and costs the
Taker nothing beyond using a modern segwit wallet.
