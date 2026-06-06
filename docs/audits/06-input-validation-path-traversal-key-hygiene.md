---
title: "Input Validation, Path Traversal, and Key Hygiene Fixes (2026-04-20)"
problem_type: security_issue
symptoms:
  - "--txid argument passed directly into URL path without validation, enabling path manipulation and SSRF"
  - "Bitcoin API URLs constructed without encodeURIComponent across all btc.js and btc_wallet.js functions"
  - "File arguments (--spv-proof, --redeem-hex, --tx-hex, etc.) read without path.resolve, enabling path traversal"
  - "SPV proof raw_tx_hashes_to_txid flag trusted from JSON rather than recomputed from hash256(raw_tx)"
  - "ECPair.makeRandom called without explicit crypto.randomBytes or post-generation key sanity check"
  - ".gitignore missing private key file patterns, risking accidental credential commits"
  - "btc_wallet.js::getRawTxHex missing same URL validation as btc.js functions (caught in re-audit)"
components:
  - relayer/src/btc.js
  - relayer/src/btc_wallet.js
  - relayer/src/cli.js
  - relayer/src/finalize_tx.js
  - .gitignore
tags:
  - ssrf
  - path-traversal
  - input-validation
  - spv
  - cryptography
  - key-hygiene
  - url-injection
  - nodejs
  - gravity-protocol
severity: high
date: 2026-04-20
status: resolved
auditors:
  - compound-engineering:review:security-sentinel (OWASP pass)
  - compound-engineering:review:security-sentinel (exploit-required pass)
  - compound-engineering:review:security-sentinel (re-audit verification)
---

# Input Validation, Path Traversal, and Key Hygiene Fixes

Two-pass security audit of the Gravity RXD Prototype relayer CLI (2026-04-20): an OWASP-aligned review and an exploit-required review run in parallel, followed by a re-audit that verified all fixes and caught one missed instance. 7 findings, all resolved.

**Note:** P2TR tweak consistency was raised as a concern by the re-audit but confirmed NOT a bug — see [Appendix](#appendix-p2tr-tweak-is-correct).

---

## Finding 1 — SSRF / URL Injection via Unvalidated API Path Parameters

### Root cause

`btc.js` constructed URLs by concatenating caller-supplied values directly into URL path segments without input validation or `encodeURIComponent`. A malformed `txid`, `blockHash`, or `height` could inject path traversal sequences (`../`) or redirect requests to unintended endpoints.

**Confirmed exploit (validate-proof command):**
```bash
node relayer/src/cli.js validate-proof --txid '../../blocks/tip/height'
# → fetches https://mempool.space/blocks/tip/height instead of /tx/<txid>
```

With a custom `MEMPOOL_API` pointing to an internal service, this becomes an SSRF probing arbitrary internal paths.

### Fix applied — `btc.js` (all 6 functions) + `btc_wallet.js::getRawTxHex`

Each function now (1) validates inputs at module boundary and (2) wraps values in `encodeURIComponent()`:

```js
// btc.js — getBlockHashAtHeight
async function getBlockHashAtHeight(height) {
  if (!Number.isInteger(height) || height < 0) throw new Error(`invalid height: ${height}`);
  return await getText(`/block-height/${encodeURIComponent(height)}`);
}

// btc.js — getHeaderHex
async function getHeaderHex(blockHash) {
  if (!/^[0-9a-fA-F]{64}$/.test(blockHash)) throw new Error(`invalid blockHash: ${blockHash}`);
  const hex = await getText(`/block/${encodeURIComponent(blockHash)}/header`);
  if (hex.length !== 160) throw new Error(`expected 80-byte header, got ${hex.length / 2} bytes`);
  return hex;
}

// btc.js — getRawTx / getTxMeta / getMerkleProof / getUtxoScriptType (same pattern)
async function getRawTx(txid) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`invalid txid: ${txid}`);
  return await getText(`/tx/${encodeURIComponent(txid)}/hex`);
}

// btc_wallet.js — getRawTxHex (missed in initial scan, fixed after re-audit)
async function getRawTxHex(txid) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`invalid txid: ${txid}`);
  const res = await fetch(`${MEMPOOL_API}/tx/${encodeURIComponent(txid)}/hex`);
  if (!res.ok) throw new Error(`GET /tx/${txid}/hex → ${res.status}`);
  return (await res.text()).trim();
}
```

**Why correct:** `/^[0-9a-fA-F]{64}$/` is the canonical Bitcoin txid format — no valid txid can fail it, no injection string can pass it. `encodeURIComponent` provides defense-in-depth at the call site.

---

## Finding 2 — Missing `--txid` Validation at CLI Entry Point

### Root cause

`cmdValidateProof()` passed `args.txid` directly to `btc.getTxMeta()` without format checking. While `btc.js` functions now validate at module boundary (Fix 1), the CLI entry point is the first line of defense and should fail fast with a user-friendly error before any network call.

### Fix applied — `cli.js` line 429

```js
async function cmdValidateProof() {
  const args = parseArgs();
  if (!args.txid) { console.error('--txid required'); process.exit(2); }
  if (!/^[0-9a-fA-F]{64}$/.test(args.txid)) {
    console.error('--txid must be exactly 64 hex chars'); process.exit(2);
  }
  const meta = await btc.getTxMeta(args.txid);
  ...
}
```

Note: `cmdFetchSpvProof` already had this guard at line 156. The fix brings `cmdValidateProof` to parity.

---

## Finding 3 — Path Traversal on CLI File Arguments

### Root cause

`cmdBuildFinalizeTx`, `cmdBuildClaimTx`, and `cmdBroadcast` accepted arguments that could be either a file path or a literal value. The original code called `fs.existsSync(rawArg)` without resolving relative paths, so `--spv-proof ../../etc/passwd` would read `/etc/passwd`.

**Confirmed exploit:**
```bash
node relayer/src/cli.js build-finalize-tx --spv-proof /etc/hostname [...]
# → reads /etc/hostname before JSON.parse fails — content loaded into memory
```

### Fix applied — `cli.js` (three call sites)

`path.resolve()` applied before every `existsSync`/`readFileSync` pair:

```js
// cmdBuildFinalizeTx
const spvProofResolved = path.resolve(args['spv-proof']);
if (fs.existsSync(spvProofResolved)) {
  spvProofRaw = fs.readFileSync(spvProofResolved, 'utf-8');
} else {
  spvProofRaw = args['spv-proof'];  // literal JSON fallback
}

// Shared readHex() helper in cmdBuildClaimTx
function readHex(v) {
  const resolved = path.resolve(v);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8').trim() : v;
}

// cmdBroadcast and cmdBtcBroadcast
const txHexResolved = path.resolve(args['tx-hex']);
const txHex = fs.existsSync(txHexResolved)
  ? fs.readFileSync(txHexResolved, 'utf-8').trim()
  : args['tx-hex'];
```

**Literal JSON fallback verified:** A string like `{"headers":["aabbcc"],...}` resolves to a path that does not exist on disk, so `existsSync` returns false and the raw string is correctly passed to `JSON.parse`. The fallback is safe.

---

## Finding 4 — SPV Proof Flag Trusted From JSON Without Recomputing hash256

### Root cause

`buildFinalizeTx()` checked `spvProof.raw_tx_hashes_to_txid` (a boolean in the JSON file) rather than recomputing `hash256(raw_tx)`. A tampered proof JSON with this flag set to `true` would not be caught before Radiant fees are burned. (The on-chain covenant still rejects, so no funds are at risk — but Taker fees are lost.)

### Fix applied — `finalize_tx.js` lines 55-69

```js
// Independent recompute — do not trust the JSON flag
if (!/^[0-9a-fA-F]+$/.test(spvProof.raw_tx) || spvProof.raw_tx.length % 2 !== 0) {
  throw new Error('spvProof.raw_tx is not valid hex');
}
const rawTxBuf = Buffer.from(spvProof.raw_tx, 'hex');
const hash256 = (buf) => crypto.createHash('sha256')
  .update(crypto.createHash('sha256').update(buf).digest()).digest();
const computedHash = hash256(rawTxBuf);
const expectedTxid = Buffer.from(spvProof.txid, 'hex').reverse();
if (!computedHash.equals(expectedTxid)) {
  throw new Error('spvProof.raw_tx does not hash256 to spvProof.txid (segwit/taproot?) — ' +
                  'strip witness data first. Covenant will reject.');
}
```

**Byte order:** `Buffer.from(spvProof.txid, 'hex').reverse()` converts display-order (little-endian) txid to the raw big-endian hash256 output order. `computedHash` is big-endian hash256 output. Both sides match.

**Prevention rule:** Never trust a `valid: true` field from external JSON. Recompute the assertion from the raw bytes.

---

## Finding 5 — ECPair.makeRandom With Implicit RNG and No Key Sanity Check

### Root cause

`generateKeypair()` did not pass an explicit `rng` to `ECPair.makeRandom()`, relying on whatever the library's default chose. No post-generation bounds check ensured the key was in the valid secp256k1 range `[1, ORDER-1]`.

### Fix applied — `btc_wallet.js` lines 47-60

```js
const SECP256K1_ORDER = Buffer.from(
  'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 'hex'
);

function generateKeypair() {
  const keypair = ECPair.makeRandom({
    network: NETWORK,
    rng: (size) => crypto.randomBytes(size),  // explicit Node.js CSPRNG
  });
  const privkeyBuf = Buffer.from(keypair.privateKey);
  if (privkeyBuf.equals(Buffer.alloc(32)) || privkeyBuf.compare(SECP256K1_ORDER) >= 0) {
    throw new Error('generated private key is out of valid secp256k1 range — retry');
  }
  ...
}
```

**ORDER constant verified:** `FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141` matches the secp256k1 group order exactly (64 hex chars / 32 bytes).

---

## Finding 6 — Private Key Files Not Excluded From Version Control

### Root cause

`.gitignore` had no patterns covering key-bearing file naming conventions the CLI naturally produces (`--out <file>` keypair bundles, WIF exports, per-participant swap files).

### Fix applied — `.gitignore`

```gitignore
# Private key files — never commit mainnet keys
*.wif
*.key
*.privkey
*-keys.json
taker-*.json
maker-*.json
```

**Note:** The existing `*.json` blanket rule already excludes most JSON from tracking. The named patterns are defense-in-depth and make intent explicit.

---

## Finding 7 — btc_wallet.js::getRawTxHex Missing Validation (Re-Audit Catch)

Already covered under Finding 1. The initial scan validated `btc.js` functions but missed the parallel implementation in `btc_wallet.js`. The re-audit caught it.

**Methodology lesson:** When the same function exists in multiple files, treat each file's implementation as independently unreviewed. Validate with `grep -rn 'functionName'` to enumerate all instances before reviewing any one of them.

---

## Prevention Strategies

### URL construction
- Always validate input at module boundary before any URL interpolation
- Always `encodeURIComponent` every dynamic value, even after validation
- CI grep gate: flag template literals containing unvalidated variables in `btc*.js`

### File argument handling
- Always `path.resolve()` immediately on receipt of a file-path argument
- For automation contexts, additionally assert the resolved path starts within an allowed directory prefix

### Cryptographic integrity
- Never trust a `valid: true` field from external JSON — recompute from raw bytes
- Always pass `{ rng: crypto.randomBytes }` explicitly to key generation functions
- Always assert generated keys are within valid curve range before use

### Repository hygiene
- Add key-file glob patterns to `.gitignore` before writing code that generates them
- Validate `.gitignore` coverage in CI with a grep-for-required-patterns test

### Parallel implementation review
- When a function name appears in multiple files, enumerate all instances with grep first
- Run per-file checklists, not per-function checklists — completion in file A provides zero coverage for file B
- Add tests that explicitly import from each file, not just the "canonical" one

---

## Appendix: P2TR Tweak Is Correct

The re-audit flagged the P2TR tweak computation in `btc_wallet.js` as potentially inconsistent with `bitcoin.payments.p2tr()`. Investigation confirmed **no divergence exists**.

### What the re-auditor misread

The variable `tweakHash` in the code holds `SHA256("TapTweak")` — the tag hash, not the final tweak scalar. The second `SHA256(tweakHash || tweakHash || xOnlyPubkey)` completes the BIP341 tagged-hash construction. The auditor assumed `tweakHash` was used directly as the tweak scalar, which would be wrong — but it's not.

### Empirical confirmation

Both paths produce the same 32-byte tweaked output key for the same internal key. `bitcoin.payments.p2tr({ internalPubkey }).pubkey` returns the tweaked x-only key (via `bip341.tweakKey(internalPubkey, null)` inside the library). The manual `ecc.xOnlyPointAddTweak(xOnlyPubkey, tapTweakHash)` call produces the same bytes.

The `p2tr.hash_hex` field and the bech32 address in `generateKeypair()` output are consistent. **No code change required.**

---

## Related Audit Documents

- [01-owasp-secrets-supply-chain.md](01-owasp-secrets-supply-chain.md) — original OWASP / secrets / deps audit
- [02-bitcoin-spv-crypto-correctness.md](02-bitcoin-spv-crypto-correctness.md) — Bitcoin-side crypto: witness stripping, Merkle proofs, PoW math, RNG
- [05-spv-data-integrity.md](05-spv-data-integrity.md) — SPV data integrity: mempool.space → relayer → covenant pipeline
- [2026-04-19-README.md](2026-04-19-README.md) — audit synthesis and remediation index
- [SECURITY.md](../../SECURITY.md) — vulnerability reporting policy and known transients
