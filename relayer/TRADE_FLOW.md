# End-to-end BTC ↔ RXD trade using this relayer

Concrete commands for executing a Gravity trade on mainnet. Assumes you
control both Maker and Taker roles (self-testing). For real trades with
separate participants, the sequence is identical but each party runs
only their own side.

## Prerequisites

- Radiant wallet with some RXD (Maker locks Photons; Taker receives Photons)
- Bitcoin wallet or coins (Taker pays BTC; Maker receives BTC)
- Node 18+, `npm ci` in `relayer/` (the repo pins exact versions)

## Role summary (BTC → RXD direction)

- **Maker** — has RXD, wants BTC. Posts covenant offering their Photons
  in exchange for a BTC payment to their specified BTC pkh.
- **Taker** — has BTC, wants RXD. Claims Maker's offer, pays BTC, then
  runs finalize() to collect the Photons.

For RXD → BTC, swap roles: the person who has RXD plays Maker, the
person with BTC plays Taker. Protocol is identical.

## Step-by-step

### 1. Maker generates a Bitcoin receive address

```bash
node src/cli.js btc-keygen --out maker-btc-keys.json
jq -r .address maker-btc-keys.json
# e.g. 1WeFdymFwwC8pEU2N3Hsm9E8RdveV6Gxd
jq -r .pkh_hex maker-btc-keys.json
# e.g. 059b28dbed87544a64318659a65af135b95dbefa
```

The `pkh_hex` (or `p2tr.hash_hex` for taproot) goes into the MakerCovenant's
`btcReceiveHash` parameter along with the chosen `--btc-type`.
**The privkey stays with the Maker** — only they can spend the received BTC.

### 2. Taker provides a Radiant receive address

Taker runs (or obtains from their Radiant wallet):
```bash
ssh <node> 'radiant-cli getnewaddress "" "legacy"'
# 15D6kjJ5o6qoMmAar31zWZch9zGew5Rz5h
```
Maker and Taker coordinate off-chain to share Taker's Radiant pkh with
Maker (a limitation of the current P2SH binding; see `GRAVITY_ANALYSIS.md`
§10o).

### 3. Maker compiles the MakerClaimed covenant for this specific trade

```bash
# Generate the covenant. The generator bakes a claimDeadline floor of
# "now - 30 days" at generation time; regenerate within 30 days of deploy
# so the floor stays reasonably current.
#
# Pick --btc-type to match the Maker receive address format (this example
# uses p2wpkh; other options are p2pkh / p2sh / p2tr / all).
node generators/gen_maker_covenant.js 6 12 --flat --btc-type p2wpkh \
  > contracts/maker_covenant_trade.rxd
node /path/to/RadiantScript/packages/cashc/dist/main/cashc-cli.js \
  contracts/maker_covenant_trade.rxd \
  -o validation/maker_covenant_trade.artifact.json

# Compute the expected P2SH commitment for MakerOffer.
#
# claimDeadline MUST be a future Unix timestamp. Recommended: now + 24h.
# extract_p2sh_code_hash.js refuses claimDeadline < now + 24h unless
# --i-understand-short-deadline=true is passed. Do NOT pass that flag
# if a counter-party asked you to — see audit 04 finding S1.
#
# expectedNBits / expectedNBitsNext: the current 4-byte LE nBits of
# Bitcoin's tip, and the nBits expected at the next retarget. If far from
# a retarget (> ~1 week away), set both to the same value. Fetch via
# `curl -s https://mempool.space/api/block/<tip hash>` and read `bits`.
CLAIM_DEADLINE=$(( $(date +%s) + 86400 ))
node reference/extract_p2sh_code_hash.js validation/maker_covenant_trade.artifact.json \
  makerPkh=<maker's Radiant pkh> \
  takerRadiantPkh=<taker's Radiant pkh (from step 2)> \
  btcReceiveHash=<maker's BTC pkh hex (20B for p2pkh/p2wpkh/p2sh, 32B for p2tr)> \
  btcSatoshis=<agreed BTC price in sats> \
  btcChainAnchor=<hash256 of anchor-block's 80B header, LE hex> \
  expectedNBits=<current Bitcoin nBits LE, e.g. 17030dd8> \
  expectedNBitsNext=<nBits for next retarget; same as expectedNBits if far from retarget> \
  claimDeadline=$CLAIM_DEADLINE \
  totalPhotonsInOutput=<Photons Maker is offering>

# → prints expectedClaimedCodeHash (32-byte hex). Save it — step 4 needs it.
```

**Taker-side independent verification (do this before claim()).** The Taker
re-runs the exact same `extract_p2sh_code_hash.js` invocation above with
the Maker-advertised param values. If the tool errors (e.g. short
deadline, banned artifact contract name), refuse the offer. If it prints
a hash, compare against the Maker-advertised `expectedClaimedCodeHash`
and against the on-chain MakerOffer's committed value. If either differs,
refuse.

### 4. Maker instantiates + deploys MakerOffer

```bash
# Compile MakerOffer template
node /path/to/cashc/dist/main/cashc-cli.js contracts/maker_offer.rxd \
  -o validation/maker_offer.artifact.json

# Instantiate with Maker's params + the hash from step 3.
# See validation/maker_offer_instantiated.js pattern.
# Outputs MakerOffer P2SH address.

# Fund the MakerOffer P2SH from Maker's Radiant wallet
radiant-cli sendtoaddress <MakerOffer P2SH> <photons + fee margin>
```

### 5. Taker claims (creates MakerClaimed UTXO)

```bash
# MakerOffer.claim() requires a Taker signature — pass the Taker's
# WIF via --privkey-file (0600-mode file) to avoid argv exposure.
#
# --expected-claimed-code-hash re-hashes the provided --claimed-redeem-hex
# and aborts if it doesn't match the 32B hash Maker committed. Strongly
# recommended; otherwise the claim is silently doomed and Radiant fees
# are burned for nothing.
node src/cli.js build-claim-tx \
  --privkey-file taker-radiant-keys.json \
  --offer-redeem-hex <path to instantiated MakerOffer hex> \
  --offer-funding-txid <maker's funding tx> \
  --offer-funding-vout 0 \
  --offer-funding-amount <sats in the offer UTXO> \
  --claimed-redeem-hex <path to instantiated MakerClaimed hex> \
  --expected-claimed-code-hash <hash from step 3> \
  --fee-sats 3000000 > claim-tx.txt

# Extract the raw hex and broadcast
grep -oE '^01[0-9a-f]+' claim-tx.txt > claim-tx.hex
node src/cli.js broadcast --tx-hex $(cat claim-tx.hex)
```

This creates a MakerClaimed UTXO on Radiant. The photons are locked
until either (a) Taker finalizes with SPV proof, or (b) `claimDeadline`
passes and Maker forfeits.

### 6. Taker pays BTC

**Option A — Taker controls a BTC wallet we generated:**

```bash
# Taker's own BTC keypair
node src/cli.js btc-keygen --out taker-btc-keys.json

# [OFF-TOOL] Fund the Taker's BTC address from existing BTC
# (exchange withdrawal, another wallet). Wait 1+ BTC confirmation.

# Query available UTXOs
node src/cli.js btc-get-utxos --address $(jq -r .address taker-btc-keys.json)
# → JSON with [{ txid, vout, value, status }, ...]

# Build the signed P2WPKH payment. The covenant requires a 1-input,
# P2WPKH (native segwit) Taker tx with the Maker payment at output[0] —
# see docs/SEGWIT_SUPPORT.md for why. The --utxo-* must refer to a
# P2WPKH (bc1q...) UTXO owned by the Taker's privkey; multi-input and
# non-segwit inputs are rejected.
#
# Pass the privkey via --privkey-file so it never hits argv (which is
# visible to ps auxww / shell history). btc-keygen --out writes 0600.
node src/cli.js btc-build-payment \
  --privkey-file taker-btc-keys.json \
  --utxo-txid <P2WPKH UTXO txid> \
  --utxo-vout <vout> \
  --utxo-amount <sats> \
  --to-hash $(jq -r .pkh_hex maker-btc-keys.json) \
  --to-type p2wpkh \
  --amount-sats <agreed BTC price> \
  --fee-sats <BTC miner fee, e.g. 500>

# Broadcast via mempool.space
node src/cli.js btc-broadcast --tx-hex <hex from previous>
# → returns btc_payment_txid
```

**Option B — Taker has an existing BTC wallet:**

> ⚠️ **Not every wallet works.** The covenant enforces a fixed tx
> layout: exactly 1 input, with one of three specific input shapes, and
> the Maker payment at output[0]. If your wallet can't produce that
> shape, your BTC will be paid but the covenant will refuse to release
> the Photons and there is **no refund path**.

Acceptable wallet configurations:

- **Native segwit** (`bc1q…` send addresses). Sparrow, Electrum
  "Standard wallet"/"p2wpkh", BlueWallet, Muun, modern bitcoin-core.
- **Taproot** (`bc1p…` send addresses). Any Taproot-enabled wallet.
- **Wrapped segwit** (`3…` send addresses, configured as "p2sh-segwit"
  or "SegWit compatibility" in your wallet). Trezor default, older
  Ledger configs, Electrum "p2sh-segwit" mode.
- **Fund a SINGLE UTXO** of one of the above types with at least
  `amount + fee`. If your wallet would auto-combine multiple inputs,
  consolidate first in a separate send.

Unacceptable (will destroy your BTC if used):

- Legacy addresses (`1…`).
- Multisig P2SH wallets (`3…` that are NOT p2sh-segwit — e.g. Casa,
  Unchained, bitcoin-core "Legacy / Multi-Sig").
- Any tx that ends up with multiple inputs. Check your wallet's tx
  preview — if it shows ≥2 inputs, cancel and consolidate first.

If you cannot guarantee the above, use Option A — the relayer tool
produces exactly the right tx shape, including P2SH-P2WPKH via
`--input-type p2sh-p2wpkh`.

See `docs/SEGWIT_SUPPORT.md` for the full explanation.

### 7. Wait for 6 BTC confirmations

~1 hour average. Can check with:
```bash
curl -s "https://mempool.space/api/tx/<btc_payment_txid>/status"
```

### 8. Fetch SPV proof

The covenant requires h1.prevHash to equal the anchor the Maker committed
to at deploy time. Pass `--anchor-height` (the block BEFORE h1) and
`--anchor-hash` (the hash256 of that anchor block's 80-byte header, LE
hex) so the relayer verifies alignment before emitting the proof.

Pass every covenant parameter so `fetch-spv-proof` runs the complete
pre-submit validator pass and exits non-zero on any mismatch. Omitting
these leaves the relayer blind to covenant rejections you could catch
before burning Radiant fees.

```bash
node src/cli.js fetch-spv-proof \
  --txid <btc_payment_txid> \
  --headers 6 \
  --merkle-depth 12 \
  --anchor-height <H-from-maker> \
  --anchor-hash <anchor-hash-from-maker> \
  --expected-nbits <current nBits LE, e.g. 17030dd8> \
  --expected-nbits-next <next-retarget nBits LE; same if far from retarget> \
  --btc-receive-hash <Maker's btcReceiveHash from step 3> \
  --btc-receive-type <p2pkh|p2wpkh|p2sh|p2tr — matching step 3's --btc-type> \
  --btc-satoshis <btcSatoshis from step 3> \
  > spv-proof.json

# Verify every invariant passes:
jq '.merkle_root_matches, .raw_tx_hashes_to_txid, .validation' spv-proof.json
# → merkle_root_matches:       true
# → raw_tx_hashes_to_txid:      true
# → validation.chain_pow_and_link: true
# → validation.chain_anchor:       true
# → validation.nbits_match:        true
# → validation.tx_structure:       true
# → validation.payment:            true
```

### 9. (No offset needed)

The covenant enforces a fixed 1-input segwit tx layout and hardcodes
outputOffset. **The Taker MUST**:

1. Use a single segwit UTXO as the BTC input. Acceptable wallet formats
   per [`docs/SEGWIT_SUPPORT.md`](../docs/SEGWIT_SUPPORT.md): P2WPKH
   (`bc1q…`), P2TR (`bc1p…`), P2SH-P2WPKH (`3…` wrapped segwit).
2. Place the Maker's payment as output[0].

If either constraint is violated, the covenant rejects and Taker's BTC
is gone without recovery.

### 10. Taker finalizes (collects Photons)

Pass the same covenant params used in step 8 — `build-finalize-tx`
re-runs the payment, nBits, and anchor checks on the SPV proof right
before emitting the spending tx, so a last-minute mismatch (e.g. stale
proof, wrong anchor) aborts before Radiant fees are paid.

```bash
node src/cli.js build-finalize-tx \
  --spv-proof spv-proof.json \
  --redeem-hex <path to instantiated MakerClaimed hex> \
  --funding-txid <claim tx from step 5> \
  --funding-vout 0 \
  --funding-amount <sats in MakerClaimed UTXO> \
  --to-address <taker Radiant address from step 2> \
  --anchor-hash <anchor-hash-from-maker> \
  --expected-nbits <same as step 8> \
  --expected-nbits-next <same as step 8> \
  --btc-receive-hash <same as step 8> \
  --btc-receive-type <same as step 8> \
  --btc-satoshis <same as step 8> \
  --fee-sats 48000000 > finalize-tx.txt

grep -oE '^01[0-9a-f]+' finalize-tx.txt > finalize-tx.hex
node src/cli.js broadcast --tx-hex $(cat finalize-tx.hex)
```

### Trade complete

- **Maker** now has BTC at their `btcReceiveHash` (controlled by `maker-btc-keys.json`)
- **Taker** now has RXD at their Radiant address (from step 2)

## Typical costs

| Side | Fee |
|---|---|
| Radiant: funding + claim + finalize | ~0.5 RXD (~fraction of a cent) |
| Bitcoin: Taker's payment tx | ~500 sats miner fee |
| Total | ~ half a cent for a trade of any size |

Makes trade sizes below ~$1 BTC equivalent impractical. Above that, any
size is economical.

## Real vs observed-payment variants

**Real Path A** (what this doc describes): Taker actually sends BTC
from their wallet. Funds flow, 6 BTC confirmations needed, ~1 hour total.

**Observed-payment test** (what `902daa91…` and `2455ed84…` did): point
the covenant at an existing confirmed BTC payment in block 840000. The
finalize() succeeds the same way on-chain, but no new BTC moves. Useful
for testing without BTC funds.

## Troubleshooting

**"mandatory-script-verify-flag-failed"** on claim or finalize:
- Check that scriptSig encoding uses OP_0 (empty push) for selector 0,
  OP_1 (0x51 opcode) for selector 1. MINIMALDATA rejects 1-byte 0x00
  or 0x01 pushes for small numbers.
- For finalize: verify `raw_tx_hashes_to_txid: true` in spv-proof.json.
  Segwit/Taproot txs will have `false` here and the covenant will reject.

**"min relay fee not met"**:
- Radiant's effective min relay is 10,000 sat/byte. A 4.8 KB finalize
  tx needs ≥48M sats (~0.48 RXD) fee. See `--fee-sats`.

**BTC payment not confirming**:
- Check fee rate on mempool.space. Increase `--fee-sats` and rebuild.
