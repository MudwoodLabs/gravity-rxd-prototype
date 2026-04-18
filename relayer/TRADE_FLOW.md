# End-to-end BTC ↔ RXD trade using this relayer

Concrete commands for executing a Gravity trade on mainnet. Assumes you
control both Maker and Taker roles (self-testing). For real trades with
separate participants, the sequence is identical but each party runs
only their own side.

## Prerequisites

- Radiant wallet with some RXD (Maker locks Photons; Taker receives Photons)
- Bitcoin wallet or coins (Taker pays BTC; Maker receives BTC)
- Node 18+, `npm install` in `relayer/`

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
node src/cli.js btc-keygen > maker-btc-keys.json
jq -r .address maker-btc-keys.json
# e.g. 1WeFdymFwwC8pEU2N3Hsm9E8RdveV6Gxd
jq -r .pkh_hex maker-btc-keys.json
# e.g. 059b28dbed87544a64318659a65af135b95dbefa
```

The `pkh_hex` goes into the MakerCovenant's `btcReceivePkh` parameter.
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
# Generate the covenant with trade parameters baked in
node generators/gen_maker_covenant.js 6 12 --flat > contracts/maker_covenant_trade.rxd
node /path/to/RadiantScript/packages/cashc/dist/main/cashc-cli.js \
  contracts/maker_covenant_trade.rxd \
  -o validation/maker_covenant_trade.artifact.json

# Compute the expected P2SH commitment for MakerOffer
node reference/extract_p2sh_code_hash.js validation/maker_covenant_trade.artifact.json \
  makerPkh=<maker's Radiant pkh> \
  takerRadiantPkh=<taker's Radiant pkh (from step 2)> \
  btcReceivePkh=<maker's BTC pkh (from step 1)> \
  btcSatoshis=<agreed BTC price in sats> \
  claimDeadline=0 \
  totalPhotonsInOutput=<Photons Maker is offering>

# → prints expectedClaimedCodeHash (32-byte hex)
```

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
node src/cli.js build-claim-tx \
  --offer-redeem-hex <path to instantiated MakerOffer hex> \
  --offer-funding-txid <maker's funding tx> \
  --offer-funding-vout 0 \
  --offer-funding-amount <sats in the offer UTXO> \
  --claimed-redeem-hex <path to instantiated MakerClaimed hex> \
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
node src/cli.js btc-keygen > taker-btc-keys.json

# [OFF-TOOL] Fund the Taker's BTC address from existing BTC
# (exchange withdrawal, another wallet). Wait 1+ BTC confirmation.

# Query available UTXOs
node src/cli.js btc-get-utxos --address $(jq -r .address taker-btc-keys.json)
# → JSON with [{ txid, vout, value, status }, ...]

# Build signed legacy payment to Maker's BTC pkh
node src/cli.js btc-build-payment \
  --privkey-wif $(jq -r .privkey_wif taker-btc-keys.json) \
  --utxo-txid <from above> \
  --utxo-vout <from above> \
  --utxo-amount <from above> \
  --to-pkh $(jq -r .pkh_hex maker-btc-keys.json) \
  --amount-sats <agreed BTC price> \
  --fee-sats <BTC miner fee, e.g. 500>

# Broadcast via mempool.space
node src/cli.js btc-broadcast --tx-hex <hex from previous>
# → returns btc_payment_txid
```

**Option B — Taker has an existing BTC wallet:**

Just send from that wallet to Maker's BTC address. The wallet must
produce LEGACY (non-segwit) outputs — modern wallets usually default
to segwit. Check the tx hex: `hash256(raw_tx)` must equal the txid
(reversed). Legacy txs start with version bytes `0100000001` (or
similar) and NEVER have the segwit marker `0001` after version.

### 7. Wait for 6 BTC confirmations

~1 hour average. Can check with:
```bash
curl -s "https://mempool.space/api/tx/<btc_payment_txid>/status"
```

### 8. Fetch SPV proof

```bash
node src/cli.js fetch-spv-proof \
  --txid <btc_payment_txid> \
  --headers 6 > spv-proof.json

# Verify:
jq '.merkle_root_matches, .raw_tx_hashes_to_txid' spv-proof.json
# → both must be `true`
```

### 9. Find the P2PKH output offset in the BTC raw tx

Pass through the SPV proof JSON:
```bash
node -e "
const p = require('./spv-proof.json');
const buf = Buffer.from(p.raw_tx, 'hex');
const targetPkh = '$(jq -r .pkh_hex maker-btc-keys.json)';
for (let o = 0; o < buf.length - 34; o++) {
  const pk = buf.slice(o + 8, o + 12).toString('hex');
  const ph = buf.slice(o + 12, o + 32).toString('hex');
  if (pk === '1976a914' && ph === targetPkh) {
    console.log('output offset:', o);
    break;
  }
}
"
```

### 10. Taker finalizes (collects Photons)

```bash
node src/cli.js build-finalize-tx \
  --spv-proof spv-proof.json \
  --redeem-hex <path to instantiated MakerClaimed hex> \
  --funding-txid <claim tx from step 5> \
  --funding-vout 0 \
  --funding-amount <sats in MakerClaimed UTXO> \
  --output-offset <from step 9> \
  --to-address <taker Radiant address from step 2> \
  --fee-sats 48000000 > finalize-tx.txt

grep -oE '^01[0-9a-f]+' finalize-tx.txt > finalize-tx.hex
node src/cli.js broadcast --tx-hex $(cat finalize-tx.hex)
```

### Trade complete

- **Maker** now has BTC at their `btcReceivePkh` (controlled by `maker-btc-keys.json`)
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
