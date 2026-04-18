#!/usr/bin/env node
/**
 * Reference implementation of the Gravity single-header PoW verifier.
 *
 * Encodes the SAME algorithm as verify_header_full.rxd, in pure Node.js.
 * If this produces the correct result for a real mainnet header, the
 * RadiantScript source is correct-by-inspection (pending compiler bugs).
 *
 * Usage:
 *   node reference_verify.js
 */

const crypto = require('crypto');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

/**
 * Mirror of verify_header_full.rxd verify(bytes header) logic.
 * Returns { hashLE, hashBE, targetLE, targetBE, chunks, pass } for inspection.
 */
function verifyHeader(headerHex) {
  const header = Buffer.from(headerHex, 'hex');
  if (header.length !== 80) throw new Error(`expected 80-byte header, got ${header.length}`);

  // --- Extract nBits ---
  const nBits = header.slice(72, 76);                    // 4 bytes LE
  const mantissaLE = nBits.slice(0, 3);                  // low 3 bytes LE
  const exponent = nBits[3];                             // high byte

  // --- Build target in LE byte order ---
  //   target_LE = zeros(exp-3) + mantissa_LE + zeros(32-exp)
  const zeroLow  = Buffer.alloc(exponent - 3);
  const zeroHigh = Buffer.alloc(32 - exponent);
  const targetLE = Buffer.concat([zeroLow, mantissaLE, zeroHigh]);
  if (targetLE.length !== 32) throw new Error(`bad target length: ${targetLE.length}`);

  // --- Hash the header ---
  const hashLE = hash256(header);                        // 32 bytes LE

  // --- Reverse both to BE for chunked compare ---
  const hBE = Buffer.from(hashLE).reverse();
  const tBE = Buffer.from(targetLE).reverse();

  // --- 8× 4-byte MSB-first unsigned chunks ---
  // Read each 4-byte chunk as a 32-bit big-endian unsigned integer.
  const hChunks = [];
  const tChunks = [];
  for (let i = 0; i < 8; i++) {
    hChunks.push(hBE.readUInt32BE(i * 4));
    tChunks.push(tBE.readUInt32BE(i * 4));
  }

  // --- Compare: hBE < tBE as unsigned 256-bit ---
  let pass = false;
  for (let i = 0; i < 8; i++) {
    if (hChunks[i] < tChunks[i]) { pass = true;  break; }
    if (hChunks[i] > tChunks[i]) { pass = false; break; }
    // equal → continue to next chunk
    // if all equal → hash == target, fails strict <
  }

  return {
    header: headerHex,
    nBitsLE: nBits.toString('hex'),
    mantissaLE: mantissaLE.toString('hex'),
    exponent,
    hashLE: hashLE.toString('hex'),
    hashBE: hBE.toString('hex'),
    targetBE: tBE.toString('hex'),
    hChunks: hChunks.map(x => x.toString(16).padStart(8, '0')),
    tChunks: tChunks.map(x => x.toString(16).padStart(8, '0')),
    pass,
  };
}

// --- Block 840000 header from blockchain.info (2024-04-20, post-halving) ---
const block840000 = '00e05f2aab948491071265ad552351d0ad625745668da54b0172010000000000000000004f89a5d73bd4d4887f25981fe81892ccafda10c27f52d6f3dd28183a7c411b03b7072366194203177d9863ea';

console.log('=== Test 1: block 840000 (known-good header) ===');
const r1 = verifyHeader(block840000);
console.log(`nBits (LE hex):    ${r1.nBitsLE}`);
console.log(`  mantissa (LE):   ${r1.mantissaLE}`);
console.log(`  exponent:        ${r1.exponent} (0x${r1.exponent.toString(16)})`);
console.log(`hash (LE):         ${r1.hashLE}`);
console.log(`hash (BE):         ${r1.hashBE}`);
console.log(`target (BE):       ${r1.targetBE}`);
console.log('');
console.log(`hash BE chunks:    ${r1.hChunks.join(' ')}`);
console.log(`target BE chunks:  ${r1.tChunks.join(' ')}`);
console.log('');
console.log(`RESULT: ${r1.pass ? 'PASS (hash < target)' : 'FAIL (hash >= target)'}`);
console.log('');

// Block 840000 hash should be: 0000000000000000000320283a2e9c41851d59dbdd7fb4e5ae3a9c1d6a25e9d0 (mainnet)
// Anything starting with "000000000000000000" is well under target (exponent 23 → ~9 leading zero bytes).
if (!r1.pass) {
  console.error('SANITY FAILURE: known-good mainnet header did not verify!');
  process.exit(1);
}

// --- Test 2: tamper with the nonce; verify it fails PoW ---
console.log('=== Test 2: tampered nonce (should fail) ===');
const tampered = block840000.slice(0, -8) + '00000000';  // replace nonce with zeros
const r2 = verifyHeader(tampered);
console.log(`tampered hash BE:  ${r2.hashBE}`);
console.log(`RESULT: ${r2.pass ? 'PASS (unexpected!)' : 'FAIL (as expected)'}`);

if (r2.pass) {
  console.error('SANITY FAILURE: tampered header verified as valid!');
  process.exit(1);
}

console.log('');
console.log('✓ Reference algorithm verified on real mainnet data.');
console.log('✓ Known-good header passes PoW check.');
console.log('✓ Tampered header fails PoW check.');
console.log('');
console.log('This algorithm is what verify_header_full.rxd encodes in RadiantScript.');
