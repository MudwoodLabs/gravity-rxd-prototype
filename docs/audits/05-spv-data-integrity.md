# Audit 05 — SPV data integrity

Focus: integrity of proof data end-to-end through the pipeline —
mempool.space (untrusted external source) → relayer → on-chain covenant.
Parity between JS reference validators and the covenant's enforcement.

---

## 1. Authoritative-source ambiguity

Before findings: there is ambiguity about what "the covenant" is.

- `contracts/maker_covenant_6x12.rxd` / `maker_covenant_flat_6x12.rxd` —
  checked-in, P2PKH-only, no chain anchor, anchors Merkle to h1 only.
- `generators/gen_maker_covenant.js` — real source of truth per
  `HANDOFF.md`; emits a contract WITH chain anchor, flexible Merkle
  anchor, per-type payment.

This audit assumes the generator output is what gets deployed and flags
the checked-in files as stale-copy drift.

---

## 2. Findings

### F-1 (SHOW-STOPPER) — Relayer does NOT run the reference validators before submitting
- Files: `relayer/src/cli.js:44-134` (`cmdFetchSpvProof`),
  `relayer/src/finalize_tx.js:53-141`
- Breaks the entire purpose of `reference/*.js`. The relayer checks ONLY:
  - `computeRoot(txid, branch) == headers[0].merkleRoot`
  - `hash256(rawTx) == txidLE`
- It does NOT run:
  - PoW per header (`reference_verify.js::verifyHeader`)
  - Chain link per header i>1 (`reference_chain.js::verifyChain`)
  - Payment output validation (`reference_payment.js::verifyPayment`) —
    except a cheap prefix match in `finalize_tx.js:76-91`
  - Chain-anchor check (`h1.prevHash == btcChainAnchor`) — entirely absent
- Confirmed by `Grep` over `relayer/`: `verifyPoW`, `verifyChain`,
  `verifyHeader`, `verifyPayment`, `reference_verify`, etc. all have zero
  hits. The `reference/*.js` files are **dead code** w.r.t. the pipeline.
- Consequence: if mempool.space returns bad data (other than a broken
  Merkle branch or witness-included rawTx), relayer submits it to chain.
  Covenant rejects with opaque RPC error. Worst case: relayer builds a tx
  whose chain anchor is wrong, wastes Radiant fees, no user-visible hint.
- **Fix:**
  1. In `cli.js::cmdFetchSpvProof`, also run:
     - `reference_verify.verifyHeader(h)` for each header
     - `reference_chain.verifyChain(headers)` (link + PoW together)
     - `reference_payment.verifyPayment(rawTx, outputOffset, btcReceivePkh,
       btcSatoshis)` if those are known
     - `headers[0].slice(4,36).equals(anchor)` if anchor is supplied
  2. Gate emission on all checks passing.
  3. Refactor `reference/*.js` to export pure functions (currently they
     run tests at module load).

### F-2 (SHOW-STOPPER) — SPV proof produced with no knowledge of covenant's payment constraints
- Files: `relayer/src/cli.js:44-134`, `relayer/src/finalize_tx.js:53-141`
- `fetch-spv-proof` takes only `--txid` and `--headers`. Emits a proof
  bundle WITHOUT knowing:
  - Which `btcReceivePkh` / `btcReceiveHash` the covenant expects
  - What `btcSatoshis` threshold applies
  - Which `btcReceiveType` (P2PKH/P2WPKH/P2SH/P2TR) branches to
  - Which `btcChainAnchor` is required
  - Which `outputOffset` within the tx is the payment (user must figure
    this out — `HANDOFF.md` step 10)
- Downstream `buildFinalizeTx` prefix-check accepts 4 types but does NOT
  verify: hash match, amount match, suffix.
- Consequence: relayer builds a tx pointing outputOffset at (say) Taker's
  change output; prefix passes; covenant rejects at
  `require(hash == btcReceiveHash)`.
- **Fix:** `buildFinalizeTx` takes `btcReceiveHash`, `btcReceiveType`,
  `btcSatoshis` as required opts and runs full `verify_payment` logic
  before emitting.

### F-3 (SHOW-STOPPER) — Relayer never aligns h1 with chain anchor
- Files: `relayer/src/cli.js:58-59`, `generators/gen_maker_covenant.js:
  279-284`, `docs/CHAIN_ANCHOR.md:33-40`
- Covenant requires `h1.prevHash == btcChainAnchor` (h1 is block H+1).
  Relayer unconditionally sets `startHeight = meta.status.block_height` —
  the block containing the tx. Tx can be in h1..hN; relayer has no way to
  know where anchor is.
- If tx lands in any block other than H+1, `h1.prevHash` ≠ anchor.
  Covenant rejects. 100% of real trades fail unless tx is in H+1 by luck.
- **Fix:** `fetch-spv-proof` needs `--anchor-height H` (or
  `--anchor-hash`). Set `startHeight = H + 1`; fetch headers H+1..H+N;
  assert tx's block is in span. Today, silently builds doomed tx.

### F-4 (SHOW-STOPPER drift) — Checked-in covenants don't match generator
- Files: `contracts/maker_covenant_6x12.rxd`,
  `contracts/maker_covenant_flat_6x12.rxd`,
  `contracts/verify_payment.rxd`
- Four mismatches between checked-in contracts and
  `generators/gen_maker_covenant.js`:
  1. No chain anchor (generator emits `require(h1Prev == btcChainAnchor)`
     at line 280-284).
  2. Merkle anchor hardcoded to h1 (generator has flexible Merkle lines
     114-119).
  3. P2PKH only (generator dispatches on `btcReceiveType`).
  4. `verify_payment.rxd` validates ONLY P2PKH — misleading in a multi-
     type world.
- Consequence: any audit/review treats checked-in as reality, diverges
  from what the generator emits.
- **Fix:** either delete checked-in `.rxd` files and make generator sole
  source (document regeneration per deployment) or regenerate them in CI.

### F-5 (HIGH) — Witness-stripping round-trip: no regression test
- File: `relayer/src/btc_wallet.js:213-241`, `relayer/src/cli.js:67-78,
  96-106`
- Pipeline relies on `bitcoinjs-lib`'s `Transaction.fromHex(...).toHex()`
  producing non-witness serialization when no witnesses attached. Mostly
  correct. But:
  - Fallback warning at `cli.js:100-106`: if witness-stripping fails to
    produce txid-matching tx, relayer prints warning and STILL EMITS proof
    with `raw_tx_hashes_to_txid: false`. `buildFinalizeTx` correctly
    refuses, but warning path has no structured reconciliation.
  - No automated test covers: segwit-v0, taproot, only-witness-input,
    minimum-size, no-outputs. `SEGWIT_SUPPORT.md:16` cites one mainnet tx.
- **Fix:** add fixture test (`relayer/test/strip_witness.test.js`) with
  5-10 real mainnet txs (legacy, segwit-v0, taproot, P2SH-P2WPKH,
  minimal). Run in CI. Pin `bitcoinjs-lib` version.

### F-6 (HIGH) — `extract_code_hash.js::indexOf(0xbd)` unsafe when state data contains 0xbd
- File: `reference/extract_code_hash.js:129-138`
- MakerClaimed's state section contains pushes of `takerRadiantPkh` (20
  bytes) and `claimDeadline`. If ANY byte of `takerRadiantPkh` is 0xbd
  (probability ~7.6% per Taker), `Buffer.indexOf(0xbd)` returns the wrong
  offset and computed `expectedClaimedCodeHash` is garbage. Maker refuses
  the correct claim.
- Non-deterministic: trade flow works 92% of time, fails 8%, no obvious
  root cause.
- **Fix:** write a proper script walker that steps over push-data. Walk
  the substituted bytes in the STATE section only.

### F-7 (HIGH) — Single-point-of-trust on mempool.space
- Files: `relayer/src/btc.js:1-91`, `relayer/src/btc_wallet.js:24, 104-
  113, 181-192`
- Every BTC source flows through mempool.space: block hash by height,
  header hex, raw tx hex, Merkle proof, tx metadata, UTXO set, broadcast.
- Risks:
  1. Selectively serve stale/orphaned chain's headers if those had
     adequate difficulty. Covenant could accept a tx on a losing branch
     that mainnet orphaned.
  2. Drop/delay — no retry, no alternate source.
  3. No fallback: no `BTC_RPC_URL`, no multi-source quorum.
- Chain anchor partially mitigates but doesn't block reorg'd-branch attacks
  where the attacker's fake chain starts from the same anchor hash.
- **Fix:** add multi-source support
  (`BTC_DATA_SOURCES=https://mempool.space/api,https://blockstream.info/api,
  http://own-node:8332`). Require at least 2 independent sources to agree.
  Surface warning when disagree. Document trust model.

### F-8 (MEDIUM) — Merkle branch depth expected by covenant is fixed
- Files: `relayer/src/proof.js:28-41`, `contracts/maker_covenant_6x12.rxd:
  276-383`
- Covenant's 6×12 variant expects EXACTLY 12 levels. For low-tx-count
  blocks, tree depth can be < 12. `buildBranch` constructs branch at
  whatever depth source gives. Covenant tries to split past the end, last
  split is empty/garbage.
- Observability: off-chain `computeRoot` check passes. Failure only at
  covenant execution.
- **Fix:** either variable-depth covenant (hard in RadiantScript), or pad
  shallow branches by duplicating last hash (Bitcoin's odd-leaf rule).

### F-9 (MEDIUM) — `hash256(rawTx)` leaf representation vs. coinbase
- Files: `relayer/src/proof.js:50-71`, `contracts/maker_covenant_6x12.rxd:
  275`
- Coinbase tx at `pos=0`: all direction bits 0, sibling on right,
  `current = hash256(current + sib)`. Correct for coinbase. But coinbase
  as "payment" is semantically invalid (doesn't pay Maker). Finalize
  would presumably reject on payment-check.
- **Fix:** `if (mp.pos === 0) { warn('coinbase as payment — will reject');
  }`

### F-10 (MEDIUM) — Endianness representation unenforced
- Files: `relayer/src/proof.js:26-41, 50-79`, `relayer/src/cli.js:80-95`
- Current conversions correct. But `extractMerkleRoot` in `proof.js:77-
  79` just slices bytes; `computeRoot` returns LE after hash256; equality
  is LE-to-LE — correct by inspection, not enforced.
- **Fix:** add `relayer/test/endianness.test.js` pinning a known block
  and asserting every conversion.

### F-11 (LOW) — `parseInt`/`Number` parsing is fragile
- File: `relayer/src/cli.js:50, 184-188, 226-229, 331-333`
- `Number('0x1000')` parses as hex; `Number('1e5')` as 100000;
  `Number('abc')` as NaN. NaN arithmetic silently pollutes.
- **Fix:** `requireInt(s, name)` helper that errors on
  `NaN || !Number.isSafeInteger(n) || n < 0`.

### F-12 (LOW) — `pos >> i` uses 32-bit signed shift
- File: `relayer/src/proof.js:31`
- JS `>>` coerces to int32. Mainnet blocks have at most ~2^13 txs — not a
  practical risk. Hygiene: use `Math.floor(pos / 2**i) & 1`.

### F-13 (LOW) — `claim_tx.js` doesn't verify `claimedRedeem` preserves Maker commitments
- File: `relayer/src/claim_tx.js:16-71`
- `buildClaimTx` takes `claimedRedeemHex` from caller with no
  verification. Taker constructing wrong redeem → P2SH doesn't match
  `expectedClaimedCodeHash` → claim fails. Deterministic fail (not silent
  money loss), but opaque UX.
- **Fix:** accept MakerOffer redeem hex; extract
  `expectedClaimedCodeHash`; recompute code-hash of `claimedRedeemHex`;
  assert match.

### F-14 (LOW) — Confirmation count not enforced before emitting proof
- File: `relayer/src/cli.js:52-56`
- Accepts any tx with `meta.status.confirmed === true` — even 1
  confirmation. Docs recommend 6-conf; code doesn't enforce.
- **Fix:** assert `meta.status.confirmations >= N` before fetching.

---

## Parity — JS reference vs. covenant

- For the SIMPLE checked-in contracts (verify_header, verify_chain2/6,
  verify_merkle1, verify_payment): references match on algorithm — hash256
  direction, LE target construction, BE chunked compare, left/right
  merkle direction, P2PKH prefix/suffix.
- For the DEPLOYED covenant as emitted by `gen_maker_covenant.js`:
  **references have drifted**.
  - `reference_payment.js` validates only P2PKH; deployed covenant
    dispatches 4 types.
  - No `reference_anchor.js`; deployed covenant has anchor check.
  - `reference_merkle.js` walks to single expected root; deployed covenant
    tries all h1..hN roots.
- References never invoked by relayer anyway (F-1), so parity is academic
  until wiring is done.

---

## Summary

### Show-stoppers for production
- **F-1:** reference validators dead-code, no pre-submit validation.
- **F-2:** SPV proof built without covenant-parameter knowledge.
- **F-3:** relayer doesn't anchor h1 to anchor-block+1.
- **F-4:** checked-in `.rxd` files drift from generator.

Fixing F-1 + F-2 + F-3 together is one coherent refactor: relayer's SPV
fetch + finalize builder must take covenant's full parameter set (anchor
height, btcReceiveHash+type, btcSatoshis, expected code hash), run every
reference validator locally, and refuse to emit a proof that won't
satisfy the covenant. ~1 week of focused work.

### Hygiene / robustness
- F-5 through F-14: witness-strip regression test, `indexOf(0xbd)` walker,
  multi-source BTC oracle, branch-depth matching, coinbase guard,
  endianness test, input validation tightening.

### Files of primary concern
- `relayer/src/cli.js` — F-1, F-2, F-3, F-11, F-14
- `relayer/src/finalize_tx.js` — F-2
- `relayer/src/btc.js` — F-7
- `relayer/src/proof.js` — F-8, F-10, F-12
- `relayer/src/btc_wallet.js` — F-5
- `relayer/src/claim_tx.js` — F-13
- `reference/extract_code_hash.js` — F-6
- `reference/reference_*.js` — F-1 (never invoked)
- `contracts/maker_covenant_{,flat_}6x12.rxd` — F-4
- `generators/gen_maker_covenant.js` — authoritative covenant source
- `docs/CHAIN_ANCHOR.md` — ground truth for F-3
