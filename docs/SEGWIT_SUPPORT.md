# Segwit / Taproot support in Gravity

Summary: **what works today vs what would require covenant changes.**

## What works today (2026-04-18)

### Taker-side segwit (fully supported)

A Taker with a segwit or taproot wallet can pay Maker today. The relayer
automatically strips witness data from the Taker's tx before passing to
the on-chain covenant. No covenant changes needed.

Relevant code: `relayer/src/btc_wallet.js::stripWitness()`, wired into
`fetch-spv-proof` as the default behavior.

Verified against block 840000 tx `0db5c99259f61b14d6e2966afe981fd81d4ddf92a64ac8955288e77f9f85b293`:
- Original (with witness): 329 bytes, `hash256 != txid` (would be rejected)
- Stripped: 136 bytes, `hash256 == txid` ✓

The Taker's tx type is invisible to the covenant — only its non-witness
serialization and P2PKH payment output matter.

### Taker's INPUT type is irrelevant

Whether the Taker spends legacy, native segwit (P2WPKH / bech32), wrapped
segwit (P2SH-P2WPKH), or taproot (P2TR) UTXOs as inputs, the relayer's
strip produces a non-witness serialization that the covenant accepts.

## What requires covenant changes

### Maker receiving to non-P2PKH addresses

The covenant's payment verifier expects the Taker's output scriptPubKey to
match exactly `0x1976a914 <20B pkh> 0x88ac` — the P2PKH pattern.

If the Maker wants to receive to a segwit address, the Taker's output
scriptPubKey structure differs:

| Type | Pattern | Len | Example prefix |
|---|---|---|---|
| P2PKH (legacy) — ✅ supported | `76a914 <20B> 88ac` | 25 | `1…` |
| P2SH | `a914 <20B> 87` | 23 | `3…` |
| P2WPKH (native segwit) | `0014 <20B>` | 22 | `bc1q…` |
| P2WSH | `0020 <32B>` | 34 | `bc1q…` |
| P2TR (taproot) | `5120 <32B>` | 34 | `bc1p…` |

Each new pattern needs its own covenant verification path.

### Estimated cost of adding P2WPKH Maker support

Adding a second payment-type branch:

- Add `btcReceiveAddressType` as a MakerCovenant constructor param (int, 0=P2PKH, 1=P2WPKH, etc.)
- In the verify-payment section, branch on that param
- P2WPKH branch:
  - Extract value (8 bytes LE at `offset`)
  - Extract script length = 22 (`0x16`)
  - Extract prefix `0x0014`
  - Extract pkh (20 bytes)
  - Require prefix matches, pkh matches, total output consumed = 22 + 8 + 1 = 31 bytes

Estimated: +~30 opcodes. Trivial relative to the 2,490-op covenant.

### Estimated cost of covering all four types

- 4 branches × ~30 ops per branch = +~120 ops
- Plus dispatch: 4-way switch based on btcReceiveAddressType = +~15 ops
- Total: +~135 ops, a ~5% increase

Fully practical.

## Recommendation

Implement in two phases:

**Phase 1** (now): Add P2WPKH Maker support. This is the format most modern
BTC wallets default to for receiving. ~30 opcode change to the covenant
generator.

**Phase 2** (later): Add P2SH and P2TR paths if demand exists. Each is
another ~30 opcodes.

Both phases are well within the covenant size budget (current: 3,570 bytes
of 32 MB limit = 0.011%).

## What DOESN'T need any changes

The relayer's `btc-build-payment` and `stripWitness` utilities are
already format-agnostic — they handle whatever legacy/segwit tx the
user constructs. The bottleneck is the covenant's hardcoded payment
pattern, not any of the off-chain tooling.

## Current user impact

Right now (until Phase 1 covenant update):
- **Taker**: any wallet works. Segwit, taproot, legacy — doesn't matter.
  Relayer auto-strips witness.
- **Maker**: must generate a legacy P2PKH address for receiving BTC.
  Can use our `btc-keygen` which produces one by default, or any BTC
  wallet that can produce a legacy address (most can, though it's often
  not the default).

No fundamental blocker to full segwit/taproot support — just engineering
extensions in the generator. The protocol design doesn't rule them out.
