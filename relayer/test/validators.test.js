#!/usr/bin/env node
/**
 * Regression tests for `reference/validators.js` — the JS mirror of the
 * covenant's pre-submit checks. Every covenant `require(...)` should
 * have a JS counterpart here; this suite verifies the core shapes.
 *
 * Run: `node test/validators.test.js` (or `npm test`).
 */

const crypto = require('crypto');
const v = require('../../reference/validators');
const btc = require('../src/btc_wallet');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? '\n    ' + detail : ''}`); failed++; }
}

// --- verifyHeader / verifyChain: use real mainnet block 840000 + 840001 ---
const block840000 = '00e05f2aab948491071265ad552351d0ad625745668da54b0172010000000000000000004f89a5d73bd4d4887f25981fe81892ccafda10c27f52d6f3dd28183a7c411b03b7072366194203177d9863ea';
const block840001 = '04002020a583da1c3ff29b687248ff737822f8ce4827033a282003000000000000000000bcc07f8618b7b063f833100724e2b40d6ee9dfa78087bfbe5d3441058a63de380e082366194203176d9026cc';

console.log('verifyHeader');
check('valid mainnet header passes', v.verifyHeader(block840000).pass);

console.log('verifyHeader rejects nBits exponent out of range');
{
  // Set exponent byte to 0x02 (< 3).
  const bad = Buffer.from(block840000, 'hex');
  bad[75] = 0x02;
  const r = v.verifyHeader(bad.toString('hex'));
  check('exponent=2 rejected', !r.pass);
  check('reason mentions exponent', /exponent/i.test(r.reason || ''));
}

console.log('verifyChain');
check('two consecutive mainnet headers pass',
  v.verifyChain([block840000, block840001]).allOk);
check('swapped order rejected',
  !v.verifyChain([block840001, block840000]).allOk);

// --- verifyNBitsMatch ---
console.log('verifyNBitsMatch');
{
  const nb = Buffer.from(block840000, 'hex').slice(72, 76).toString('hex');
  check('matching nBits passes', v.verifyNBitsMatch([block840000], nb).pass);
  check('mismatched nBits rejects', !v.verifyNBitsMatch([block840000], 'ffffffff').pass);
  check('alt nBits (expectedNBitsNext) passes',
    v.verifyNBitsMatch([block840000], 'ffffffff', nb).pass);
}

// --- verifyAnchor ---
console.log('verifyAnchor');
{
  const prevHash = Buffer.from(block840001, 'hex').slice(4, 36).toString('hex');
  check('correct prevHash passes', v.verifyAnchor(block840001, prevHash).pass);
  check('wrong prevHash rejects',
    !v.verifyAnchor(block840001, '00'.repeat(32)).pass);
  check('bad anchor length rejects',
    !v.verifyAnchor(block840001, 'aa'.repeat(10)).pass);
}

// --- verifyTxStructure: build txs via the segwit builder ---
console.log('verifyTxStructure');
{
  const kp = btc.generateKeypair();
  const tx = btc.buildSignedPaymentTx({
    privkeyWif: kp.privkey_wif,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
    toType: 'p2wpkh', toHashHex: kp.p2wpkh.hash_hex,
    amountSats: 100000, feeSats: 500,
  });
  const stripped = btc.stripWitness(tx.txHex).nonWitnessHex;
  const r = v.verifyTxStructure(stripped);
  check('native-segwit tx passes', r.pass);
  check('outputOffset = 47', r.outputOffset === 47);
  check('inputShape = p2wpkh-or-p2tr', r.inputShape === 'p2wpkh-or-p2tr');

  // P2SH-P2WPKH variant
  const tx2 = btc.buildSignedPaymentTx({
    privkeyWif: kp.privkey_wif,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
    toType: 'p2wpkh', toHashHex: kp.p2wpkh.hash_hex,
    amountSats: 100000, feeSats: 500, inputType: 'p2sh-p2wpkh',
  });
  const stripped2 = btc.stripWitness(tx2.txHex).nonWitnessHex;
  const r2 = v.verifyTxStructure(stripped2);
  check('P2SH-P2WPKH tx passes', r2.pass);
  check('outputOffset = 70', r2.outputOffset === 70);
  check('inputShape = p2sh-p2wpkh', r2.inputShape === 'p2sh-p2wpkh');

  // 64-byte tx rejected
  check('64-byte tx rejected', !v.verifyTxStructure('ab'.repeat(64)).pass);
  // 65-byte tx also rejected by the new length guard (too short for any real output)
  check('65-byte tx rejected (length guard)', !v.verifyTxStructure('ab'.repeat(65)).pass);
}

// --- verifyPayment: builds synthetic P2WPKH output and verifies ---
console.log('verifyPayment');
{
  const pkh = 'bb'.repeat(20);
  // Build a tx with a known P2WPKH output at offset 47.
  const kp = btc.generateKeypair();
  const tx = btc.buildSignedPaymentTx({
    privkeyWif: kp.privkey_wif,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 1000000 }],
    toType: 'p2wpkh', toHashHex: pkh,
    amountSats: 100000, feeSats: 500,
  });
  const stripped = btc.stripWitness(tx.txHex).nonWitnessHex;

  check('correct pkh + sats passes',
    v.verifyPayment(stripped, 47, pkh, 100000, 'p2wpkh').pass);
  check('value < required rejects',
    !v.verifyPayment(stripped, 47, pkh, 100001, 'p2wpkh').pass);
  check('wrong pkh rejects',
    !v.verifyPayment(stripped, 47, 'cc'.repeat(20), 100000, 'p2wpkh').pass);
  check('unknown type rejects',
    !v.verifyPayment(stripped, 47, pkh, 100000, 'invalid').pass);
}

console.log(`\nvalidators tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
