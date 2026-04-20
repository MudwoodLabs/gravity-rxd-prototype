# Audit 02 — Bitcoin / SPV crypto correctness

Focus: Bitcoin-side code — witness parsing, tx construction, SPV proof
format, Merkle verification in JS. Where the subtle consensus-level bugs
live. RadiantScript and economic attacks are out of scope (see separate
reports).

---

## CRITICAL

### Finding 1 — 64-byte tx Merkle forgery (rawTx length not validated)
- Files: `relayer/src/finalize_tx.js:73`, `relayer/src/cli.js`
  (fetch-spv-proof flow), `reference/reference_payment.js:25-33`
- Bitcoin's Merkle tree computes interior nodes as
  `hash256(leftChild || rightChild)` — the same 32-byte-concat-then-hash
  used for a leaf. A 64-byte "transaction" is indistinguishable from a
  concatenation of two 32-byte child hashes. An attacker who finds or
  constructs a 64-byte value that hash256-collides with a real interior
  node of a valid Bitcoin block can present that blob as a "raw tx" with a
  crafted Merkle branch that skips some levels, and pass SPV checks for a
  tx that never existed.
- Bitcoin Core defends by enforcing `tx.size != 64` at block-validation.
  Pure-header SPV has no such automatic defense — it must explicitly reject
  64-byte rawTx.
- Reproducer: attacker finds an interior node `N` of a valid block. Build
  64-byte blob `X` where `X[0..32]` and `X[32..64]` are the children of
  `N`. Submit proof with `rawTx = X` and a branch from `N` up to root.
  Parse bytes of `X` as-if-tx; with ~2^48 grinding shape the output bytes
  to look like a P2PKH paying Maker.
- Fix:
  ```js
  if (rawTxBuf.length <= 64) throw new Error('rawTx must be > 64 bytes');
  ```
  Add in `finalize_tx.js`, `cli.js::fetch-spv-proof`, and
  `reference_payment.js`.
- Severity: **Critical** if the on-chain covenant also doesn't enforce
  minimum rawTx length. **High** if the covenant does but JS lacks
  defense-in-depth. Covenant reviewer must confirm.

---

## MEDIUM

### Finding 5 — `finalize_tx.js` prefix check does not validate output value, hash bytes, or byte-count
- File: `relayer/src/finalize_tx.js:76-91`
- The JS validator's `knownPrefixes` check only confirms that bytes
  `[offset+8..offset+12]` form a recognized script-type prefix. It does NOT
  verify:
  - That the hash bytes equal the Maker's expected `btcReceiveHash`.
  - That the output's 8-byte value meets any threshold.
  - That the output is not zero-value.
- The comments say "checks output matching is the covenant's job." But if
  the covenant also fails to check value, an attacker could submit an SPV
  proof of a 0-sat-value output paying Maker and claim the Radiant side.
- Severity: documentation gap on JS side. Cross-reference audit 03
  (Covenant) finding C2.

---

## LOW

### Finding 2 — `btc.js:57` comment is misleading
- File: `relayer/src/btc.js:57`
- Comment says `/tx/:txid/hex` returns "NON-witness serialization"; mempool
  actually returns full segwit serialization. Code in `cli.js:71` correctly
  calls `stripWitness` to handle. A future developer trusting the comment
  could bypass the strip.
- Fix: correct the comment.

### Finding 3 — No negative-mantissa or out-of-range nBits rejection
- Files: `reference/reference_verify.js:30-39`, `reference/reference_chain.js:22-32`
- `Buffer.alloc(exponent - 3)` throws for `exponent < 3 || > 32`. Bitcoin
  Core rejects `exponent > 0x1d` and mantissa-high-bit-set as negative.
  This JS accepts anything that doesn't throw. Not exploitable for forgery
  (the resulting target is tiny), but an uncaught exception is a DoS.
- Fix: explicit bound check before `Buffer.alloc`.

### Finding 11 — Length check insufficient for full P2PKH parse
- File: `relayer/src/finalize_tx.js:73`
- `rawTxBuf.length < outputOffset + 22` allows reading 12 bytes of prefix.
  Full P2PKH output is 8+1+25 = 34 bytes. If `outputOffset+22 ≤ len <
  outputOffset+34`, JS check passes but output is truncated. Covenant
  catches on-chain.
- Fix: use `outputOffset + 34` for P2PKH; parameterize per type.

---

## No bug found (checked, clean)

- **Finding 7 — `stripWitness()` delegation to bitcoinjs-lib.** Correct.
  `readVarInt()`/`readVector()` handle >252 elements; setting
  `input.witness = []` then `toHex()` triggers the non-segwit path; `hash256`
  of stripped output matches txid. Mixed legacy+segwit inputs OK. Taproot
  single-vs-script-path OK.
- **Finding 8 — Merkle-proof direction encoding (`proof.js:28-71`).**
  Correct. `(pos >> i) & 1` is the standard Bitcoin convention. `[dir_byte]
  [32B sibling]` format is unambiguous.
- **Finding 9 — Coinbase tx handling.** `isCoinbase()` is never consulted;
  no special case, no misparse.
- **Finding 10 — RNG and signing.** `ECPair.makeRandom` uses
  `crypto.getRandomValues`. No `Math.random()`. ECDSA uses RFC6979
  deterministic nonces via `tiny-secp256k1`. `lowR` not set (cosmetic,
  not a security issue).
- **Finding 12 — zeroLow/zeroHigh in target construction.** Correct for
  exponent 3..32. Matches Bitcoin Core's `CompactToBig`.

---

## Summary

- **Critical:** 1 (64-byte tx rejection missing). Exploitability depends on
  whether covenant also rejects — confirm from audit 03.
- **Medium:** 1 (JS doesn't enforce output value / hash — intentional, but
  covenant must do it).
- **Low:** 3 (comment accuracy, nBits robustness, length check tightness).
- **No bug:** 5 areas checked (witness strip, Merkle direction, coinbase,
  RNG, target math).

The stripWitness logic, Merkle direction encoding, hash256-double-SHA,
RNG sourcing, and RFC6979 deterministic signing are all correct. The PoW
verifier's core algorithm (256-bit unsigned BE compare against target) is
correct, with only edge-case nBits-format robustness gaps that are not
exploitable.
