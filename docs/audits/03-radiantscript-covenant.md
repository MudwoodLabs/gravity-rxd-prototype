# Audit 03 — RadiantScript covenant

Focus: covenant opcode semantics, state transitions, arithmetic bounds,
MINIMALDATA, generator-vs-generated drift. Bitcoin-side crypto and
economic attacks are in separate reports.

---

## CRITICAL (covenant-level show-stoppers)

### C1. No difficulty bound on nBits — chain-anchor insufficient to prevent forgery
- Files: `contracts/verify_header.rxd:29-34`, `contracts/verify_chain6.rxd`
  (every powBlock), `contracts/maker_covenant_6x12.rxd:26-29`,
  `maker_covenant_flat_6x12.rxd:18-21`,
  `generators/gen_maker_covenant.js:47-82` (powBlock),
  `reference/reference_verify.js:28-39`
- The covenant extracts `nBits` from each header and requires
  `hash256(header) < target(nBits)`, but places NO upper bound on how
  large `target` may be. An attacker can set
  `nBits = 0xffffff20` (mantissa=0xFFFFFF, exponent=32), producing target
  ≈ 0xffffff00 << (8*28) — ~99.99% of 2^256. Any hash passes.
- Combined with the fact that **the attacker authors h1**, they can:
  1. Set `h1.prevHash = btcChainAnchor` (satisfying the anchor check),
  2. Set `h1.nBits` to a trivial target,
  3. Grind the nonce until hash passes (seconds),
  4. Chain h2..hN identically (attacker picks each prevHash),
  5. Author `h1.merkleRoot` to commit to a Merkle tree with a fake
     "payment" tx to `btcReceivePkh`,
  6. Supply the SPV proof → covenant accepts → attacker drains Maker.
- The chain anchor (`CHAIN_ANCHOR.md`) is described as "cryptographically
  tying the SPV proof to mainnet" — this is **false**. The anchor binds
  only the prev-hash link of h1. Without a difficulty bound, h1 is
  forgeable with pocket change.
- **Fix options (any is sufficient):**
  - Maker commits to expected `nBits` at deploy time; covenant requires
    `nBits == expectedNBits` (cheapest; valid for a ~2-week retarget
    window). Alternatively an allow-list of possible values.
  - Covenant enforces `target <= maxTarget`; Maker updates periodically.
  - Any production deployment without one of these is broken.

### C2. P2PKH payment verification is forgeable via attacker-chosen outputOffset
- Files: `contracts/verify_payment.rxd:36-60`,
  `contracts/maker_covenant_flat_6x12.rxd:389-398`,
  `contracts/maker_covenant_6x12.rxd:389-398`,
  `generators/gen_maker_covenant.js:133-189`,
  `reference/reference_payment.js:25-60`
- `outputOffset` is an unlocking-script arg chosen by the spender. The
  covenant does NOT:
  - Parse varints to validate `outputOffset` points to an actual tx output,
  - Check that `outputOffset + 34 <= rawTx.length` (only implicit via
    `.split` aborting),
  - Verify `output_count`, skip inputs, etc.
- It simply slices 34 bytes at the attacker-chosen offset and pattern-
  matches `<8B value> 19 76a914 <pkh> 88ac`. An attacker can construct a
  real BTC tx containing that byte sequence inside an OP_RETURN data push
  and point `outputOffset` at it. The "payment" never has to actually pay
  Maker.
- POC: attacker builds a BTC tx with
  `Output 1: OP_RETURN <value_8B LE=<≥btcSatoshis>> 19 76a914 <makerBtcPkh> 88ac`,
  confirms ≥ 6 blocks, submits finalize with outputOffset at the embedded
  pattern. Cost: 1 BTC tx fee (~$0.10).
- Independent of C1 — this works even if difficulty bound is added.
- **Fix:** covenant must enforce that `outputOffset` points to a
  structurally-real output. Cheapest: require the Taker to pass
  input_count and reconstruct `outputOffset == version(4) +
  varint(inputCount) + sum(inputs) + varint(outputCount)`. More robust:
  require Maker's output is output[0] of the tx.

### C3. Generator–covenant severe drift
- Files: `contracts/maker_covenant_6x12.rxd`,
  `contracts/maker_covenant_flat_6x12.rxd` vs
  `generators/gen_maker_covenant.js`
- The generator, run today, produces a contract with:
  - `btcChainAnchor` param + `require(h1Prev == btcChainAnchor)` (line 280),
  - `require(current == root1 || ... || rootN)` flexible Merkle (line 118),
  - `bytes btcReceiveHash` + 4-way P2PKH/P2WPKH/P2SH/P2TR dispatch,
  - Contract names with type suffix (`MakerCovenant6x12_p2pkh`).
- The committed `.rxd` files have NONE of these. They have:
  - No anchor,
  - Strict h1.merkleRoot-only (`require(current == expectedRoot)`),
  - `bytes20 btcReceivePkh`, P2PKH-only hardcoded.
- Documentation (`HANDOFF.md`, `docs/CHAIN_ANCHOR.md`) describes the
  generator version as reality. Anyone following the repo's instructions
  deploys a weaker covenant than the docs describe.
- **Fix:** regenerate and commit the `.rxd` from the current generator, OR
  delete the stale files and generate at build time.

---

## HIGH

### H1. `maker_offer.rxd` binding uses `hash256(codeScript)` but codeScript semantics depend on deployment wrapper
- Files: `contracts/maker_offer.rxd:45`,
  `reference/extract_code_hash.js:141-151`,
  `reference/extract_p2sh_code_hash.js:100-118`
- `require(hash256(tx.outputs[0].codeScript) == expectedClaimedCodeHash);`
  The two reference helpers compute DIFFERENT hashes:
  - `extract_code_hash.js` hashes bytes FROM stateSeparator to end.
  - `extract_p2sh_code_hash.js` hashes the 23-byte P2SH scriptPubKey.
- On a P2SH deployment (the repo's chosen form), the P2SH helper is
  correct; the state-separated helper is wrong for P2SH. Picking wrong =
  nobody can spend via claim path → locked funds.
- Also: the P2SH `scriptHash` includes the state-section params
  (takerRadiantPkh, claimDeadline). Binding via P2SH commits to a specific
  Taker — defeating the state-separation advantage. Documented as a known
  limitation in HANDOFF.
- **Fix:** pick one helper, delete or rename the other. Add a test that
  compiles MakerOffer with a given `expectedClaimedCodeHash` and verifies
  on-chain evaluation matches.

### H2. `maker_claimed.rxd` finalize() is a stub with NO SPV verification
- File: `contracts/maker_claimed.rxd:44-48`
- `finalize()` only checks the output is a P2PKH lock to `takerRadiantPkh`
  and value ≥ `totalPhotonsInOutput`. It does NOT verify any SPV proof. If
  this file is deployed instead of the 6x12 covenant, ANYONE can finalize
  and drain. File is annotated "[STUB]" but still compiles.
- **Fix:** delete, or rename to
  `maker_claimed_stub_DO_NOT_DEPLOY.rxd` with an un-compileable marker.

### H3. `claimDeadline = 0` default makes forfeit/finalize race immediately
- Files: `contracts/maker_claimed.rxd:53`,
  `contracts/maker_covenant_6x12.rxd:407`,
  `maker_covenant_flat_6x12.rxd:399`, `relayer/src/forfeit_tx.js:51`,
  `HANDOFF.md` (demo plan)
- With `claimDeadline=0`, `require(tx.time >= 0)` is trivially satisfied;
  forfeit() is callable immediately. A malicious Maker running a relayer
  can race-broadcast forfeit the instant after the Taker's claim,
  sniping the Taker's BTC payment.
- **Fix:** default must be a future timestamp. Reject
  `claimDeadline < now + min_window`. Update demo + relayer defaults.

### H4. Merkle-proof CVE-2012-2459 surface (SPV-inherent)
- Files: all Merkle verifiers.
- Bitcoin's Merkle tree permits last-leaf duplication on odd counts. An
  attacker can sometimes forge a branch such that an inner-node hash
  coincidentally equals `hash256(X || X)`. Known issue in all SPV schemes.
- Requires ~80-bit hash collision work. Combined with C1/C2, risk
  compounds.
- **Partial mitigation:** require Merkle depth match expected depth for
  the block's tx count. Not simple.

### H5. 64-byte tx short-branch attack (SPV-inherent)
- See audit 02 Finding 1. Covenant must reject `rawTx.length <= 64`.

---

## MEDIUM

### M1. nBits exponent not sanity-checked
- Files: `verify_header.rxd:34`, all powBlocks.
- `bytes t = bytes(0, e - 3) + m + bytes(0, 32 - e);`. If `e < 3`,
  `e - 3` is negative. Behavior of `bytes(0, -N)` in RadiantScript is
  undefined; probably traps. At worst passes garbage. Adds fragility.
- **Fix:** `require(e >= 3 && e <= 32);` before target construction.

### M2. nBits sign-bit / mantissa high-bit not rejected
- Files: `verify_header.rxd:26-34`, etc.
- Bitcoin consensus rejects nBits where mantissa high bit is set. This
  covenant doesn't. Not a practical attack vector given C1 dominates.
- **Fix:** belt-and-suspenders require.

### M3. Timestamp (nTime) never checked
- Files: `verify_header.rxd`, all chain verifiers.
- The covenant reads bytes [68..72] nowhere. Under C1, an attacker forging
  headers uses any nTime. For the paper's security analysis of "timestamps
  within 2 hours," this is a gap.

---

## LOW

### L1. MINIMALDATA-suspect direction-byte encoding
- Files: `verify_merkle1.rxd:20`, Merkle steps in 6x12 covenants.
- `if (dir0 == 0x00)` compiles to `<1-byte 0x00 push> OP_EQUAL` — non-
  minimal under SCRIPT_VERIFY_MINIMALDATA (should be OP_0). Deployed
  contracts work, so Radiant mainnet policy evidently doesn't enforce
  MINIMALDATA on this — brittle w.r.t. consensus upgrades.
- **Fix:** change convention to numeric comparison with BIN2NUM, or OP_0.

### L2. Hand-edited vs generator: verify_chain2.rxd and verify_merkle1.rxd
- No "auto-generated" banner; content differs from generators. If regenerated,
  would break anything using the hand-edited ABIs.
- **Fix:** add DO-NOT-EDIT banners where appropriate; pin handwritten
  files explicitly.

### L3. Sequence numbers (noted as correct)
- `forfeit_tx.js:50` uses `0xFFFFFFFE` (required for CLTV);
  `finalize_tx.js:124` and `claim_tx.js:54` use `0xFFFFFFFF`. Correct. Not
  a finding; noted for documentation.

### L4. `tx.outputs[0].value >= totalPhotonsInOutput` allows over-payment
- Files: `maker_offer.rxd:47`, `maker_claimed.rxd:47`, 6x12 covenants.
- The check is `>=` not `==`. If the input UTXO contains significantly more
  photons than `totalPhotonsInOutput`, they can all route to Taker — no
  change-back-to-Maker. Maker loses the excess.
- **Fix:** document deployment guidance that funding UTXO should be tight.

---

## Reference-vs-covenant divergence

| Reference | Covenant | Match? |
|---|---|---|
| `reference_verify.js` PoW chunked compare | `verify_header.rxd` / chainN | Match |
| `reference_chain.js` chain link | `verify_chain6.rxd` | Match |
| `reference_merkle.js` | `verify_merkle1.rxd` | Match |
| `reference_payment.js` | `verify_payment.rxd` | Match; BOTH share C2 |
| `extract_code_hash.js` | `maker_offer.rxd` binding | Mismatch for P2SH (H1) |

References and covenants share bugs (C1, C2) — consistent but equally
wrong.

---

## Areas not conclusively verified

1. Whether `SCRIPT_VERIFY_MINIMALDATA` is enforced by default on Radiant
   mainnet (L1 depends on this).
2. RadiantScript `bytes(0, -N)` behavior (M1 assumes it aborts).
3. `tx.time` semantics on Radiant vs `OP_CHECKLOCKTIMEVERIFY`.
4. Whether on-chain MakerOffer binding works for state-separated
   MakerCovenant that is NOT P2SH-wrapped.
5. Merkle depth 12 adequacy against current BTC block sizes.

---

## Net assessment

C1 and C2 are each independently sufficient to drain any deployed covenant
for cents of attacker cost. They are present in BOTH the committed
covenants AND the generator output — this is not a "regenerate and fix"
situation. **The covenant as designed is not safe to hold value.**

The fact that ~0.78 RXD moved on mainnet reflects that no attacker has
yet targeted this specific protocol; it does not indicate the covenant
is secure.

The project's paper-level security model (§6, ~$428k/block forgery cost)
assumes mainnet difficulty and structural tx-output parsing. The covenant
doesn't enforce either.
