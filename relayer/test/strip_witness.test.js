#!/usr/bin/env node
/**
 * Regression test for `btc_wallet.stripWitness` (audit 05 F-5).
 *
 * The covenant computes hash256(rawTx) at finalize time to derive the
 * Merkle leaf. For segwit txs, the full wire serialization includes
 * marker/flag/witness bytes, and hash256 of that yields the wtxid —
 * not the txid. Stripping marker/flag/witness must recover the legacy
 * non-witness serialization whose hash256 equals txid.
 *
 * A dep-version drift or a bitcoinjs-lib parser regression in this area
 * would quietly break every Gravity trade. This suite builds txs in
 * every supported shape, strips them, and asserts round-trip equality.
 *
 * Run: `node test/strip_witness.test.js` (or `npm test` in the relayer).
 */

const crypto = require('crypto');
const btc = require('../src/btc_wallet');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? '\n    ' + detail : ''}`);
    failed++;
  }
}

function testStripRoundTrip(label, tx) {
  console.log(`\n${label}`);
  const stripInfo = btc.stripWitness(tx.txHex);
  const stripped = Buffer.from(stripInfo.nonWitnessHex, 'hex');
  const h = hash256(stripped);
  // Bitcoin txid is hash256 of stripped serialisation displayed in
  // reversed (BE) order; `tx.txId` comes back BE-hex from bitcoinjs-lib.
  const txidLE = Buffer.from(tx.txId, 'hex').reverse();
  check('stripped length sane', stripped.length > 10);
  check('hash256(stripped) == txid (LE)', h.equals(txidLE),
    `  got ${h.toString('hex')}, want ${txidLE.toString('hex')}`);
  check('was_segwit flag matches', stripInfo.wasSegwit === true);
}

// Build sample txs in every supported input/output combination.
const kp = btc.generateKeypair();
const cases = [
  // Native P2WPKH input (default)
  ['P2WPKH input → P2PKH output',    'p2wpkh',      'p2pkh',  kp.p2pkh.hash_hex],
  ['P2WPKH input → P2WPKH output',   'p2wpkh',      'p2wpkh', kp.p2wpkh.hash_hex],
  ['P2WPKH input → P2SH output',     'p2wpkh',      'p2sh',   kp.p2sh_p2wpkh.hash_hex],
  ['P2WPKH input → P2TR output',     'p2wpkh',      'p2tr',   kp.p2tr.hash_hex],
  // Wrapped P2SH-P2WPKH input (Phase 5 addition)
  ['P2SH-P2WPKH input → P2PKH output',  'p2sh-p2wpkh', 'p2pkh',  kp.p2pkh.hash_hex],
  ['P2SH-P2WPKH input → P2WPKH output', 'p2sh-p2wpkh', 'p2wpkh', kp.p2wpkh.hash_hex],
  ['P2SH-P2WPKH input → P2SH output',   'p2sh-p2wpkh', 'p2sh',   kp.p2sh_p2wpkh.hash_hex],
  ['P2SH-P2WPKH input → P2TR output',   'p2sh-p2wpkh', 'p2tr',   kp.p2tr.hash_hex],
];

for (const [label, inputType, toType, toHashHex] of cases) {
  const tx = btc.buildSignedPaymentTx({
    privkeyWif: kp.privkey_wif,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
    toType, toHashHex, amountSats: 500000, feeSats: 500, inputType,
  });
  testStripRoundTrip(label, tx);
}

// Edge case: change below dust (no change output) — single-output tx.
console.log('\nSingle-output tx (change swept to fee)');
{
  const tx = btc.buildSignedPaymentTx({
    privkeyWif: kp.privkey_wif,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 100000 }],
    toType: 'p2wpkh', toHashHex: kp.p2wpkh.hash_hex,
    // Push change below 546-sat dust threshold so it merges into fee.
    amountSats: 99800, feeSats: 100,
  });
  testStripRoundTrip('1-input-1-output P2WPKH', tx);
  // After witness-strip, byte[4] is inputCount (not outputCount — that's
  // at byte 46 for P2WPKH). Verify the stripped serialization has the
  // expected 1-input shape.
  const stripped = Buffer.from(btc.stripWitness(tx.txHex).nonWitnessHex, 'hex');
  check('stripped inputCount == 1', stripped[4] === 0x01);
  check('stripped outputCount == 1', stripped[46] === 0x01);
}

// Sanity: a non-segwit tx should pass stripWitness unchanged.
console.log('\nPassthrough on a non-segwit hex');
{
  // Minimal fake legacy tx with 1 input + 1 output, no witness. bitcoinjs-lib
  // parses/reserialises legacy txs without marker/flag, so strip is a no-op.
  const legacyHex =
    '01000000' +             // version
    '01' +                   // inputCount
    'aa'.repeat(32) +        // prev txid
    '00000000' +             // prev vout
    '00' +                   // empty scriptSig
    'ffffffff' +             // sequence
    '01' +                   // outputCount
    'e803000000000000' +     // 1000 sat value
    '16' +                   // scriptLen
    '00140d6caa96ba6d43f6d99f73fa16cfb5d9bbaf3c9e' +  // P2WPKH script
    '00000000';              // locktime
  const info = btc.stripWitness(legacyHex);
  check('legacy passthrough: wasSegwit === false', info.wasSegwit === false);
  check('legacy passthrough: hex unchanged', info.nonWitnessHex === legacyHex);
}

console.log(`\nstripWitness tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
