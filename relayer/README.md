# gravity-relayer

Off-chain helper that fetches Bitcoin SPV data and formats it for unlocking the
Gravity protocol's on-chain `finalize()` path.

## Status: minimum viable skeleton

Currently implements:
- Bitcoin data fetching via mempool.space API (headers, raw tx, Merkle proof)
- Format conversion from Bitcoin's standard Merkle proof layout to the
  covenant's expected wire format (`[dir_byte][32-byte sibling LE]` per level)
- Off-chain validation that the computed Merkle root matches the block header
- CLI for producing finalize() witness data

Not yet implemented (scope for later sessions):
- `broadcast` — submit to a Radiant RPC endpoint
- `claim` — drive the Taker-side State-1 → State-2 transition
- Witness-stripping for segwit/taproot source txs (mitigation: require Takers
  use legacy format, which they always can since they construct the payment tx)

## Install

```bash
cd relayer
npm ci   # use npm ci (not npm install) — respects the pinned lockfile
```

## Commands

### `fetch-spv-proof --txid <btc-txid> [--headers N]`

Fetches the full SPV-proof payload for a confirmed Bitcoin transaction.
Output is a single JSON object containing:

- `headers`: array of N consecutive 80-byte block headers (hex) starting at
  the block that contains `txid`
- `raw_tx`: the raw transaction hex
- `branch`: the Merkle branch in covenant format (N × 33 bytes)
- `computed_root_LE` / `expected_root_LE`: cross-check fields
- `merkle_root_matches`: bool
- `raw_tx_hashes_to_txid`: bool (false for segwit/taproot txs — the on-chain
  covenant will fail unless the tx is re-serialized without witness data)
- `warnings`: array of human-readable warnings

Example:
```bash
node src/cli.js fetch-spv-proof \
  --txid 2406f00c71f84f46ab0130d9ee766a756fc0b8b8b7614ec54f23578e99b736c6 \
  --headers 6
```

### `validate-proof --txid <btc-txid>`

Just checks whether the Merkle proof reconstructs the block's merkleRoot
correctly. Prints PASS or FAIL. Useful for debugging format questions without
the full witness dump.

### `build-finalize-tx --spv-proof <file-or-json> --redeem-hex <hex> --funding-txid <txid> --funding-vout <n> --funding-amount <sats> --output-offset <n> --to-address <addr> --fee-sats <n>`

Assembles the Radiant spending tx that exercises the `finalize()` path of
a MakerClaimed covenant UTXO. No signing required — finalize is a
relay-driven path where anyone with a valid SPV proof can trigger it;
routing to the Taker is enforced by the covenant's state (takerRadiantPkh).

Inputs:
- `--spv-proof`: either a JSON file path or literal JSON string, matching
  the output of `fetch-spv-proof`. Must have `merkle_root_matches: true`
  and `raw_tx_hashes_to_txid: true` or build will refuse.
- `--redeem-hex`: the full MakerClaimed locking bytecode, with both code
  and state sections populated. The Taker reconstructs this from the
  template + their specific state values.
- `--funding-*`: the MakerClaimed UTXO reference (created by the Taker's
  earlier claim() tx).
- `--output-offset`: byte offset within the Bitcoin raw tx where the
  P2PKH output paying Maker's `btcReceivePkh` starts. Computed off-chain
  by the relayer (no need to parse varints on-chain).
- `--to-address`: Radiant address to receive the photons. Must match the
  `takerRadiantPkh` baked into the MakerClaimed UTXO's state, or the
  covenant will reject.
- `--fee-sats`: Radiant tx fee. Min relay is 10,000 sat/byte; a 4.8 KB
  finalize tx needs ≥48M sats (~0.5 RXD).

Output: raw tx hex ready for `sendrawtransaction`.

Example (dry-run with real block 840000 SPV proof + synthetic MakerClaimed):
```
$ node src/cli.js build-finalize-tx \
    --spv-proof /tmp/spv_proof.json \
    --redeem-hex <hex from a MakerClaimed instance> \
    --funding-txid 00...01 \
    --funding-vout 0 \
    --funding-amount 100000000 \
    --output-offset 153 \
    --to-address 1HBoQHQjPzv2jnQQEaFaotY2gCJejj6JT7 \
    --fee-sats 60000000

=== finalize() spending tx ===
MakerClaimed UTXO:  ...:0 (100000000 sats)
Fee:                60000000 sats
Output:             40000000 sats to 1HBoQHQjPzv2jnQQEaFaotY2gCJejj6JT7
Tx size:            4748 bytes
ScriptSig size:     4661 bytes
  redeem script:    3536 bytes
  witness count:    9 (headers + branch + rawTx + outputOffset)
```

## Design notes

### Merkle proof format

Our covenant expects each branch level as `[direction_byte][sibling_hash_LE]`:
- direction = `0x00` if the current hash is on the left and sibling is on the right
- direction = `0x01` if the current hash is on the right and sibling is on the left

Derived from the transaction's position index in the block:
```js
dir_at_level_i = ((pos >> i) & 1) === 0 ? 0x00 : 0x01
```

mempool.space returns sibling hashes in BIG-endian display order. We reverse
each to LE before including in the branch, because Bitcoin internally hashes
LE-concatenated children and `OP_HASH256` produces LE.

### hash256(raw_tx) must equal txid

On-chain, the covenant does `hash256(rawTx)` to derive the Merkle leaf. For
legacy (non-segwit) txs this equals the txid. For segwit/taproot txs the full
serialization includes witness data, and hash256 of those bytes gives the
wtxid — NOT the txid. The Merkle tree stores txids, so the proof would fail.

Mitigation: since the Taker constructs the payment tx themselves, they can
always use legacy format. The relayer surfaces a warning when a supplied
txid is segwit-serialized so this isn't a silent failure.

### Data source

`MEMPOOL_API` env var can override the base URL (default: `https://mempool.space/api`).
For production you'd point at your own Bitcoin node's REST interface or a
self-hosted mempool.space instance.

## Example session

```bash
$ node src/cli.js validate-proof --txid 2406f00c71f84f46ab0130d9ee766a756fc0b8b8b7614ec54f23578e99b736c6
txid:     2406f00c71f84f46ab0130d9ee766a756fc0b8b8b7614ec54f23578e99b736c6
block:    840000 / pos 26 / depth 12
computed: 4f89a5d73bd4d4887f25981fe81892ccafda10c27f52d6f3dd28183a7c411b03
expected: 4f89a5d73bd4d4887f25981fe81892ccafda10c27f52d6f3dd28183a7c411b03
result:   PASS
```

The computed root matches block 840000's merkleRoot exactly — the same proof
would be accepted by our `verify_merkle12.rxd` covenant on-chain.
