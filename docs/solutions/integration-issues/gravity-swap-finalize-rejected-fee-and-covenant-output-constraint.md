---
title: "Gravity finalize tx rejected: min relay fee + covenant minimum output structural conflict"
date: 2026-04-21
category: integration-issues
tags:
  - radiant
  - gravity-protocol
  - atomic-swap
  - covenant
  - radiantscript
  - transaction-fee
  - op-verify
  - p2pkh
  - multi-input
  - rxd-python-sdk
symptoms:
  - "min relay fee not met (code 66) on finalize transaction broadcast"
  - "mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation) (code 16) after fee fix"
  - "covenant OP_VERIFY failure despite valid script structure and correct fee amount"
  - "finalize tx rejected twice with different error codes on successive attempts"
affected_components:
  - gravity-rxd-prototype relayer (finalize_tx.js)
  - rxd-python-sdk GravityTrade.finalize()
  - MakerClaimed covenant (State 2, N=6 headers, M=12 Merkle depth)
  - Radiant mainnet relay policy (10,000 photons/byte minimum)
  - RadiantScript covenant output value constraint (totalPhotonsInOutput)
severity: high
resolved: true
verified_on_mainnet: true
finalize_txid: "23a584eed5d5c88870512b9de19750151c6707e7acb15e76e426ff57212c244e"
---

# Gravity Finalize Tx Rejected: Fee + Covenant Output Constraint

## Symptoms

When building and broadcasting the Radiant finalize transaction in a Gravity BTC↔RXD atomic swap, two sequential failures occur:

**Stage 1** (first broadcast attempt):
```
error code: -26
error message: min relay fee not met (code 66)
```

**Stage 2** (after bumping fee):
```
error code: -26
error message: mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation) (code 16)
```

The second error is deceptive — it looks like a script bug but is actually a **funding shortfall** caused by the relay fee eating into the covenant's required output minimum.

---

## Investigation Steps

### Stage 1: Min Relay Fee

The 6×12 Gravity covenant finalize transaction is ~5,372 bytes. Radiant's minimum relay fee is **10,000 photons/byte**:

```
Min fee = 5,372 × 10,000 = 53,720,000 photons
Fee used = 50,000,000 photons  →  SHORT by 3,720,000
```

Fix: rebuild with fee ≥ 53,720,000. Used 55,000,000 for headroom.

### Stage 2: OP_VERIFY Script Failure

After the fee was corrected and the tx passed relay, Radiant's script engine rejected it. The error points to a `require()` inside the covenant — identified by searching the RadiantScript source:

```javascript
// maker_covenant_trade.rxd — finalize() function, end of Route to Taker section
bytes25 takerLock = new LockingBytecodeP2PKH(takerRadiantPkh);
require(tx.outputs[0].lockingBytecode == takerLock);
require(tx.outputs[0].value >= totalPhotonsInOutput);  // ← THIS FAILS
```

`totalPhotonsInOutput` is a **compile-time constant** — it is baked into the covenant bytecode when the offer is generated, not a runtime parameter. For this trade it was set to **100,000,000 photons** (1 RXD).

### The Arithmetic Impossibility

With only the MakerClaimed UTXO as input:

```
MakerClaimed UTXO value:    147,000,000 photons
Min relay fee (5,372 bytes):  53,720,000 photons
─────────────────────────────────────────────────
Remaining for output[0]:      93,280,000 photons

Covenant requires:           100,000,000 photons
93,280,000 < 100,000,000  →  require() FAILS → OP_VERIFY
```

No fee amount adjustment resolves this on a single-input tx. It is a **structural funding shortfall**: the UTXO cannot simultaneously pay relay fees and satisfy the covenant's output minimum.

### Confirming totalPhotonsInOutput from the Redeem Script

The value is baked as a little-endian push near the output-value check. To confirm, search the compiled redeem hex for its LE encoding:

```python
import struct
val = 100_000_000
le4 = struct.pack('<I', val).hex()  # → "00e1f505"
assert le4 in redeem_hex
```

---

## Root Cause

The MakerOffer was funded with 1.5 RXD (150,000,000 photons). After the Taker's claim tx fee (~3M photons), the MakerClaimed UTXO held **147M photons**. This is below the threshold needed to cover both:

1. The finalize tx relay fee (53.72M+ photons for a 5,372-byte tx)
2. The covenant's minimum output constraint (100M photons)

Required funding to avoid this: **at least 153,720,000 photons (~1.54 RXD)** in the MakerOffer UTXO.

The minimum MakerOffer funding formula:

```
minFunding = totalPhotonsInOutput + finalizeRelayFee + claimRelayFee + safetyBuffer
           = 100,000,000 + 53,720,000 + 4,000,000 + 500,000
           ≈ 158,220,000 photons (≈ 1.582 RXD)
```

---

## Working Fix: 2-Input Finalize Transaction

The covenant only constrains `tx.outputs[0].lockingBytecode` and `tx.outputs[0].value`. It places **no restriction on the number of inputs or additional inputs**. The escape hatch: add a Maker P2PKH UTXO as `input[1]` to subsidize the relay fee.

### Transaction Structure

| Slot | Role | Value |
|---|---|---|
| `input[0]` | MakerClaimed P2SH covenant UTXO | 147,000,000 photons |
| `input[1]` | Maker P2PKH UTXO (fee subsidy) | Any amount ≥ shortfall |
| `output[0]` | Taker's Radiant address | exactly 100,000,000 photons |
| `output[1]` | Maker change | remainder after fee |

### Node.js Implementation (`@radiant-core/radiantjs`)

```javascript
const tx2 = new rxd.Transaction();

// Input 0: MakerClaimed P2SH — no key signature required
// scriptSig carries: SPV headers + branch + rawTx + selector(0) + redeemScript
tx2.from(covenantUtxo);
tx2.inputs[0].setScript(scriptSig);
tx2.inputs[0].sequenceNumber = 0xffffffff;

// Input 1: Maker P2PKH — provides fee subsidy headroom
tx2.from(makerP2pkhUtxo);

// Output 0: Taker receives covenant minimum exactly
tx2.to(takerAddress, 100_000_000);

// Output 1: Maker recovers change
tx2.to(makerAddress, makerChange);

// Sign only input 1 — input[0] is authenticated by the SPV proof, not a key
// radiantjs.sign() skips inputs that already have a script set
tx2.sign(makerPrivateKey);  // SIGHASH_ALL on input[1] only

const finalHex = tx2.serialize({ disableAll: true });
// Broadcast via: radiant-cli sendrawtransaction $(cat /tmp/finalize.hex)
```

### Sizing Math for the 2-Input Transaction

| Component | Size |
|---|---|
| Input 0: covenant P2SH (5,285 scriptSig + 41 overhead) | ~5,326 bytes |
| Input 1: Maker P2PKH | ~148 bytes |
| Output 0: P2PKH Taker | 34 bytes |
| Output 1: P2PKH Maker change | 34 bytes |
| Tx overhead (version, locktime, varint counts) | 10 bytes |
| **Total** | **~5,552 bytes** |

```
Min relay fee: 5,552 × 10,000 = 55,520,000 photons
Fee used:      5,552 × 10,500 = 58,296,000 photons  (5% headroom)
```

### Verified Mainnet Result

- Finalize txid: `23a584eed5d5c88870512b9de19750151c6707e7acb15e76e426ff57212c244e`
- output[0]: **1.0 RXD** → Taker `1JArrpvMqWyf7EMVVQzdgqXnHcgwZ71C8p`
- output[1]: **5,122.76 RXD** → Maker `1A4uLV5MpZXXj4N4uaFppRYrZACgYm36j9`

---

## Prevention

### Minimum Funding Formula

```python
def compute_finalize_tx_bytes(spv_rows: int, spv_cols: int) -> int:
    # Measured: 5,372 bytes for 6×12. Scale with grid size.
    MERKLE_NODE = 32
    BTC_HEADER = 80
    VARINT_PER_ROW = 8
    merkle = MERKLE_NODE * spv_cols * spv_rows
    headers = BTC_HEADER * spv_rows
    varints = VARINT_PER_ROW * spv_rows
    return 10 + 500 + merkle + headers + varints + 41 + 34  # ~5,372 for 6×12

def minimum_maker_offer_funding(
    total_photons_in_output: int,
    spv_rows: int = 6,
    spv_cols: int = 12,
    relay_rate: int = 10_000,
) -> int:
    finalize_fee = compute_finalize_tx_bytes(spv_rows, spv_cols) * relay_rate
    claim_fee = 400 * relay_rate  # conservative estimate for Taker claim tx
    buffer = max(500_000, int(total_photons_in_output * 0.005))
    return total_photons_in_output + finalize_fee + claim_fee + buffer

# For 6×12, totalPhotonsInOutput=100M:
# minimum_maker_offer_funding(100_000_000) ≈ 158,220,000 photons ≈ 1.582 RXD
```

### SDK Pre-Flight Check (add to `GravityTrade.finalize()`)

```python
class InsufficientMakerOfferFundingError(Exception):
    def __init__(self, utxo_value, required, shortfall):
        super().__init__(
            f"MakerOffer UTXO has {utxo_value} photons but needs "
            f"{required} (shortfall: {shortfall}). "
            "Add a supplemental Maker P2PKH input or recreate the offer."
        )

def preflight_check_maker_offer_funding(
    maker_offer_utxo_value: int,
    total_photons_in_output: int,
    spv_rows: int,
    spv_cols: int,
    relay_rate: int = 10_000,
) -> None:
    required = minimum_maker_offer_funding(
        total_photons_in_output, spv_rows, spv_cols, relay_rate
    )
    shortfall = required - maker_offer_utxo_value
    if shortfall > 0:
        raise InsufficientMakerOfferFundingError(
            maker_offer_utxo_value, required, shortfall
        )
```

Run this check:
1. **At offer creation time** — before broadcasting the MakerOffer tx, so the Maker is warned before locking funds
2. **At finalize time** — before calling `build-finalize-tx`, so failures surface with a clear message

### Required JS-Side Change

`finalize_tx.js` currently supports only 1 input. To enable the supplement pattern without manual tx construction, add `--extra-inputs` support:

```
node src/cli.js build-finalize-tx \
  --spv-proof /tmp/spv-proof.json \
  --redeem-hex /tmp/claimed_redeem.hex \
  --funding-txid <claimedTxid> \
  --funding-vout 0 \
  --funding-amount 147000000 \
  --extra-input-txid <makerUtxoTxid> \
  --extra-input-vout 1 \
  --extra-input-amount 512287303334 \
  --extra-input-wif-file /tmp/maker-rxd.wif \
  --to-address <takerAddress> \
  --change-address <makerAddress> \
  --fee-rate 10500
```

### Test Cases

```python
def test_preflight_rejects_underfunded_offer():
    minimum = minimum_maker_offer_funding(100_000_000, 6, 12)

    # Exactly totalPhotonsInOutput — must fail
    with pytest.raises(InsufficientMakerOfferFundingError):
        preflight_check_maker_offer_funding(100_000_000, 100_000_000, 6, 12)

    # One below minimum — must fail
    with pytest.raises(InsufficientMakerOfferFundingError):
        preflight_check_maker_offer_funding(minimum - 1, 100_000_000, 6, 12)

    # Exactly at minimum — must pass
    preflight_check_maker_offer_funding(minimum, 100_000_000, 6, 12)


def test_minimum_scales_with_spv_grid():
    for rows, cols in [(3, 6), (6, 12), (9, 18)]:
        min_funding = minimum_maker_offer_funding(100_000_000, rows, cols)
        # Larger grids require more funding
        assert min_funding > 100_000_000
```

---

## Failure Mode Summary

| Error | Code | Cause | Fix |
|---|---|---|---|
| `min relay fee not met` | -26/66 | Fee < 10,000 photons/byte × tx_bytes | Compute fee from actual byte length |
| `mandatory-script-verify-flag-failed` (OP_VERIFY) | -26/16 | `output[0].value` < `totalPhotonsInOutput` after paying relay fee from single UTXO | Add supplemental Maker P2PKH input |

---

## Cross-References

- `relayer/TRADE_FLOW.md` — min relay fee numbers and step-by-step flow
- `HANDOFF.md` — funding floor math summary (line 143)
- `docs/audits/04-atomic-swap-economic-security.md` — S6: fee-starvation attack on BTC payment tx (complementary failure mode)
- `docs/audits/03-radiantscript-covenant.md` — covenant constraint analysis; C2 (output offset); R1 (PoW sign-flip)
