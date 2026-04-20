/**
 * Pure, importable exports of the four SPV reference validators:
 *
 *   verifyHeader(headerHex)            — single-header PoW (mirrors
 *                                         verify_header.rxd)
 *   verifyChain(headersHex)            — PoW + chain linking across N headers
 *                                         (mirrors verify_chainN.rxd)
 *   verifyMerkle(leafLE, branchBuf,    — Merkle branch inclusion
 *                expectedRoot)           (mirrors verify_merkleN.rxd)
 *   verifyPayment(rawTxHex, offset,    — P2PKH payment output check
 *                pkhHex, minSats)        (mirrors verify_payment.rxd)
 *   verifyAnchor(h1Hex, anchorHex)     — h1.prevHash == expected anchor
 *                                         (mirrors the generator's anchor
 *                                         require)
 *
 * The companion files (`reference_*.js`) contain runnable smoke tests. This
 * module is importable without triggering those tests, so the relayer can
 * use the same logic for its pre-submit sanity pass.
 *
 * Safety hardening layered over the originals (flagged by the 2026-04-19
 * audit):
 *   - rawTx length > 64 required in verifyPayment (64-byte-tx Merkle
 *     collision defense, audit 02 Finding 1).
 *   - nBits exponent bounded to [3, 32] (audit 03 M1).
 */

const crypto = require('crypto');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function verifyPoW(header) {
  if (header.length !== 80) {
    return { pass: false, reason: `expected 80-byte header, got ${header.length}` };
  }
  const nBits = header.slice(72, 76);
  const mantissaLE = nBits.slice(0, 3);
  const exponent = nBits[3];

  if (exponent < 3 || exponent > 32) {
    return { pass: false, reason: `nBits exponent ${exponent} out of range [3,32]` };
  }

  const targetLE = Buffer.concat([
    Buffer.alloc(exponent - 3),
    mantissaLE,
    Buffer.alloc(32 - exponent),
  ]);

  const hashLE = hash256(header);
  const hBE = Buffer.from(hashLE).reverse();
  const tBE = Buffer.from(targetLE).reverse();

  for (let i = 0; i < 8; i++) {
    const h = hBE.readUInt32BE(i * 4);
    const t = tBE.readUInt32BE(i * 4);
    if (h < t) return { pass: true, hashLE, hBE, nBitsLE: nBits };
    if (h > t) return { pass: false, reason: 'hash >= target', hashLE, hBE };
  }
  return { pass: false, reason: 'hash == target', hashLE, hBE };
}

function verifyHeader(headerHex) {
  return verifyPoW(Buffer.from(headerHex, 'hex'));
}

function verifyChain(headersHex) {
  const headers = headersHex.map(h => Buffer.from(h, 'hex'));
  const results = [];
  let prevHash = null;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    let linkOk = true;
    if (i > 0) {
      const prevField = h.slice(4, 36);
      linkOk = prevField.equals(prevHash);
    }
    const pow = verifyPoW(h);
    results.push({
      index: i,
      powOk: pow.pass,
      linkOk,
      reason: pow.pass ? (linkOk ? 'ok' : 'chain-link mismatch') : pow.reason,
    });
    prevHash = pow.hashLE;
  }

  const allOk = results.every(r => r.powOk && r.linkOk);
  return { allOk, results };
}

function verifyMerkle(leafLE, branchBuf, expectedRoot) {
  if (branchBuf.length % 33 !== 0) {
    return { pass: false, reason: 'branch length must be multiple of 33' };
  }
  const depth = branchBuf.length / 33;
  let current = Buffer.from(leafLE);
  for (let i = 0; i < depth; i++) {
    const entry = branchBuf.slice(i * 33, (i + 1) * 33);
    const dir = entry[0];
    const sib = entry.slice(1, 33);
    current = dir === 0
      ? hash256(Buffer.concat([current, sib]))
      : hash256(Buffer.concat([sib, current]));
  }
  return { pass: current.equals(expectedRoot), computed: current };
}

// Payment prefix lookup per BTC output type. Each entry is the fixed byte
// prefix a rawTx output has, plus the hash length, plus the fixed suffix
// (empty for segwit/taproot since the whole scriptPubKey is length-prefixed).
// Values are hex strings for clarity.
const PAYMENT_TYPES = {
  p2pkh:  { prefix: '1976a914', hashLen: 20, suffix: '88ac', outputLen: 34 }, // 8B value + 26B script
  p2wpkh: { prefix: '160014',   hashLen: 20, suffix: '',     outputLen: 31 }, // 8B value + 23B script
  p2sh:   { prefix: '17a914',   hashLen: 20, suffix: '87',   outputLen: 32 }, // 8B value + 24B script
  p2tr:   { prefix: '225120',   hashLen: 32, suffix: '',     outputLen: 43 }, // 8B value + 35B script
};

function verifyPayment(rawTxHex, outputOffset, expectedHashHex, requiredSatoshis, type = 'p2pkh') {
  const rawTx = Buffer.from(rawTxHex, 'hex');

  // 64-byte tx Merkle-collision defense (audit 02 Finding 1).
  if (rawTx.length <= 64) {
    return { pass: false, reason: 'rawTx length ≤ 64 (Merkle collision risk)' };
  }

  const spec = PAYMENT_TYPES[type];
  if (!spec) return { pass: false, reason: `unknown payment type ${type}` };

  const expectedHash = Buffer.from(expectedHashHex, 'hex');
  if (expectedHash.length !== spec.hashLen) {
    return { pass: false, reason: `hash must be ${spec.hashLen} bytes, got ${expectedHash.length}` };
  }

  if (rawTx.length < outputOffset + spec.outputLen) {
    return { pass: false, reason: `tx too short for ${type} output at offset ${outputOffset}` };
  }

  const output = rawTx.slice(outputOffset, outputOffset + spec.outputLen);

  const value = Number(output.readBigUInt64LE(0));
  if (value < requiredSatoshis) {
    return { pass: false, reason: `value ${value} < required ${requiredSatoshis}`, value };
  }

  const prefixBytes = Buffer.from(spec.prefix, 'hex');
  const prefix = output.slice(8, 8 + prefixBytes.length);
  if (!prefix.equals(prefixBytes)) {
    return { pass: false, reason: `${type} prefix mismatch: got ${prefix.toString('hex')}, want ${spec.prefix}`, value };
  }

  const hashStart = 8 + prefixBytes.length;
  const hash = output.slice(hashStart, hashStart + spec.hashLen);
  if (!hash.equals(expectedHash)) {
    return { pass: false, reason: `hash mismatch: got ${hash.toString('hex')}, want ${expectedHashHex}`, value };
  }

  if (spec.suffix) {
    const suffixBytes = Buffer.from(spec.suffix, 'hex');
    const suffixStart = hashStart + spec.hashLen;
    const suffix = output.slice(suffixStart, suffixStart + suffixBytes.length);
    if (!suffix.equals(suffixBytes)) {
      return { pass: false, reason: `${type} suffix mismatch: got ${suffix.toString('hex')}, want ${spec.suffix}`, value };
    }
  }

  return { pass: true, value, hash: hash.toString('hex') };
}

// Check every header's nBits matches ONE of the Maker-committed expected
// values. This mirrors the covenant's
// `require(n{i} == expectedNBits || n{i} == expectedNBitsNext)` — two
// values lets a trade span a retarget boundary without bricking.
// `expectedNBitsNextHex` is optional; if omitted, defaults to the same
// value as `expectedNBitsHex` (non-retarget case).
function verifyNBitsMatch(headersHex, expectedNBitsHex, expectedNBitsNextHex) {
  const expected = Buffer.from(expectedNBitsHex, 'hex');
  if (expected.length !== 4) {
    return { pass: false, reason: 'expectedNBits must be 4 bytes (LE hex)' };
  }
  const expectedNext = expectedNBitsNextHex
    ? Buffer.from(expectedNBitsNextHex, 'hex')
    : expected;
  if (expectedNext.length !== 4) {
    return { pass: false, reason: 'expectedNBitsNext must be 4 bytes (LE hex)' };
  }
  for (let i = 0; i < headersHex.length; i++) {
    const h = Buffer.from(headersHex[i], 'hex');
    const n = h.slice(72, 76);
    if (!n.equals(expected) && !n.equals(expectedNext)) {
      return {
        pass: false,
        reason: `header[${i}] nBits ${n.toString('hex')} matches neither ` +
          `${expectedNBitsHex} nor ${expectedNBitsNextHex || '(same)'}`,
      };
    }
  }
  return { pass: true };
}

// Verify the rawTx follows one of the Taker-input shapes the covenant
// accepts. Mirrors the two-branch structural check in
// generators/gen_maker_covenant.js:
//   (a) Native segwit (P2WPKH/P2TR): empty scriptSig → outputOffset = 47
//   (b) P2SH-P2WPKH: 23-byte scriptSig 0x16 0x00 0x14 <20B> → outputOffset = 70
function verifyTxStructure(rawTxHex) {
  const rawTx = Buffer.from(rawTxHex, 'hex');
  if (rawTx.length <= 64) return { pass: false, reason: 'rawTx length must be > 64' };
  if (rawTx[4] !== 0x01) return { pass: false, reason: `inputCount must be 1 (got 0x${rawTx[4].toString(16)})` };

  let outputOffset, outputCountByte, inputShape;
  const scriptSigLen = rawTx[41];
  if (scriptSigLen === 0x00) {
    outputOffset = 47;
    outputCountByte = 46;
    inputShape = 'p2wpkh-or-p2tr';
  } else if (scriptSigLen === 0x17) {
    if (rawTx[42] !== 0x16) return { pass: false, reason: `expected 0x16 at byte 42, got 0x${rawTx[42].toString(16)}` };
    if (rawTx[43] !== 0x00) return { pass: false, reason: `expected 0x00 at byte 43 (segwit v0), got 0x${rawTx[43].toString(16)}` };
    if (rawTx[44] !== 0x14) return { pass: false, reason: `expected 0x14 at byte 44 (push 20), got 0x${rawTx[44].toString(16)}` };
    outputOffset = 70;
    outputCountByte = 69;
    inputShape = 'p2sh-p2wpkh';
  } else {
    return {
      pass: false,
      reason: `scriptSig must be empty (native segwit, 0x00) or 23-byte ` +
              `P2SH-P2WPKH redeem (0x17); got length 0x${scriptSigLen.toString(16)}`,
    };
  }

  // Sanity: the tx must contain enough bytes for outputCount + at least a
  // minimum output at outputOffset. The smallest output the covenant
  // accepts is P2WPKH/P2TR (31 bytes); we enforce at least that much plus
  // the 4-byte locktime tail to avoid returning pass on truncated data.
  const MIN_TAIL = 31 + 4;
  if (rawTx.length < outputOffset + MIN_TAIL) {
    return {
      pass: false,
      reason: `rawTx too short for output at offset ${outputOffset} ` +
              `(need ≥ ${outputOffset + MIN_TAIL} bytes, got ${rawTx.length})`,
    };
  }

  const outputCount = rawTx[outputCountByte];
  if (outputCount === 0x00) return { pass: false, reason: 'outputCount must be >= 1' };
  if (outputCount >= 0xfd) return { pass: false, reason: `outputCount varint not 1-byte (got 0x${outputCount.toString(16)})` };
  return { pass: true, outputOffset, inputShape };
}

// Check that the FIRST header in the proof chain extends the expected
// chain anchor: header.prevHash == anchor.
function verifyAnchor(h1Hex, anchorHex) {
  const h1 = Buffer.from(h1Hex, 'hex');
  if (h1.length !== 80) {
    return { pass: false, reason: 'h1 is not 80 bytes' };
  }
  const expected = Buffer.from(anchorHex, 'hex');
  if (expected.length !== 32) {
    return { pass: false, reason: 'anchor is not 32 bytes' };
  }
  const h1Prev = h1.slice(4, 36);
  return { pass: h1Prev.equals(expected), got: h1Prev.toString('hex') };
}

module.exports = {
  hash256,
  verifyPoW,
  verifyHeader,
  verifyChain,
  verifyMerkle,
  verifyPayment,
  verifyAnchor,
  verifyNBitsMatch,
  verifyTxStructure,
  PAYMENT_TYPES,
};
