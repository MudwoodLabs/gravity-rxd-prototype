#!/usr/bin/env node
/**
 * Reference implementation of the BTC payment output verifier.
 * Mirrors verify_payment.rxd.
 *
 * Validates that a Bitcoin tx output at given offset is:
 *   - P2PKH to expected pkh
 *   - value >= required satoshis
 *
 * Also validates the contract's algorithm by constructing a synthetic tx,
 * running the algorithm on it, and also testing rejection paths.
 */

const crypto = require('crypto');

/**
 * Same logic the contract executes:
 *   output = rawTx[outputOffset..outputOffset+34]
 *   value = int(output[0..8])      LE→int
 *   prefix = output[8..12] == 0x1976a914  (script_len + OP_DUP OP_HASH160 push20)
 *   pkh = output[12..32]           must match expected
 *   suffix = output[32..34] == 0x88ac   (OP_EQUALVERIFY OP_CHECKSIG)
 *   value >= requiredSatoshis
 */
function verifyPayment(rawTxHex, outputOffset, expectedPkhHex, requiredSatoshis) {
  const rawTx = Buffer.from(rawTxHex, 'hex');
  const expectedPkh = Buffer.from(expectedPkhHex, 'hex');

  if (rawTx.length < outputOffset + 34) {
    return { pass: false, reason: 'tx too short for output at this offset' };
  }

  const output = rawTx.slice(outputOffset, outputOffset + 34);

  // Value: first 8 bytes LE
  const value = Number(output.readBigUInt64LE(0));
  if (value < requiredSatoshis) {
    return { pass: false, reason: `value ${value} < required ${requiredSatoshis}`, value };
  }

  // Prefix check: [len=0x19][OP_DUP=0x76][OP_HASH160=0xa9][push20=0x14]
  const prefix = output.slice(8, 12);
  if (!prefix.equals(Buffer.from('1976a914', 'hex'))) {
    return { pass: false, reason: `bad prefix ${prefix.toString('hex')}`, value };
  }

  // pkh: 20 bytes
  const pkh = output.slice(12, 32);
  if (!pkh.equals(expectedPkh)) {
    return { pass: false, reason: `pkh mismatch: got ${pkh.toString('hex')}, want ${expectedPkhHex}`, value };
  }

  // Suffix: [OP_EQUALVERIFY=0x88][OP_CHECKSIG=0xac]
  const suffix = output.slice(32, 34);
  if (!suffix.equals(Buffer.from('88ac', 'hex'))) {
    return { pass: false, reason: `bad suffix ${suffix.toString('hex')}`, value };
  }

  return { pass: true, value, pkh: pkh.toString('hex') };
}

/**
 * Build a minimal legacy (non-segwit) Bitcoin tx with one P2PKH output.
 * Returns { rawTxHex, outputOffset, pkhHex, valueSatoshis }.
 */
function buildSyntheticTx(pkhHex, valueSatoshis) {
  const version = Buffer.from('01000000', 'hex');                           // LE
  const inputCount = Buffer.from('01', 'hex');
  const prevOutpoint = Buffer.alloc(36, 0xab);                              // fake 36 bytes
  const scriptSig = Buffer.from('00', 'hex');                               // empty, length 0
  const sequence = Buffer.from('ffffffff', 'hex');
  const input = Buffer.concat([prevOutpoint, scriptSig, sequence]);

  const outputCount = Buffer.from('01', 'hex');

  // Build P2PKH output
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(valueSatoshis), 0);
  const scriptLen = Buffer.from('19', 'hex');                               // 25 bytes
  const p2pkh = Buffer.concat([
    Buffer.from('76a914', 'hex'),                                           // OP_DUP OP_HASH160 push20
    Buffer.from(pkhHex, 'hex'),
    Buffer.from('88ac', 'hex'),                                             // OP_EQUALVERIFY OP_CHECKSIG
  ]);
  const output = Buffer.concat([value, scriptLen, p2pkh]);

  const locktime = Buffer.from('00000000', 'hex');

  const rawTx = Buffer.concat([version, inputCount, input, outputCount, output, locktime]);

  // Compute output offset:
  //   version(4) + inputCount(1) + input(36+1+4=41) + outputCount(1) = 47
  const outputOffset = version.length + inputCount.length + input.length + outputCount.length;

  return {
    rawTxHex: rawTx.toString('hex'),
    outputOffset,
    pkhHex,
    valueSatoshis,
    txid: crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(rawTx).digest()
    ).digest().reverse().toString('hex'),
  };
}

// ====== Tests ======

const testPkh = 'aabbccddeeff00112233445566778899aabbccdd';  // 20 bytes
const testValue = 50000000;                                  // 0.5 BTC

const tx = buildSyntheticTx(testPkh, testValue);
console.log('=== Synthetic legacy P2PKH tx ===');
console.log(`Raw hex:         ${tx.rawTxHex}`);
console.log(`Total length:    ${tx.rawTxHex.length / 2} bytes`);
console.log(`Output offset:   ${tx.outputOffset}`);
console.log(`Txid (BE):       ${tx.txid}`);
console.log('');

// Test 1: correct pkh, correct amount
console.log('=== Test 1: correct pkh + amount ===');
let r = verifyPayment(tx.rawTxHex, tx.outputOffset, testPkh, testValue);
console.log(`  Result: ${r.pass ? 'PASS' : 'FAIL'}  reason=${r.reason ?? 'ok'}  value=${r.value}`);
if (!r.pass) { console.error('SANITY FAILURE'); process.exit(1); }

// Test 2: require less than actual
console.log('=== Test 2: require less than actual (should pass) ===');
r = verifyPayment(tx.rawTxHex, tx.outputOffset, testPkh, testValue - 1);
console.log(`  Result: ${r.pass ? 'PASS' : 'FAIL'}  value=${r.value}`);
if (!r.pass) { console.error('SANITY FAILURE'); process.exit(1); }

// Test 3: require more than actual → must fail
console.log('=== Test 3: require MORE than actual (should fail) ===');
r = verifyPayment(tx.rawTxHex, tx.outputOffset, testPkh, testValue + 1);
console.log(`  Result: ${r.pass ? 'PASS (unexpected!)' : 'FAIL (as expected)'}  reason=${r.reason}`);
if (r.pass) { console.error('SANITY FAILURE'); process.exit(1); }

// Test 4: wrong pkh → must fail
console.log('=== Test 4: wrong pkh (should fail) ===');
const wrongPkh = '0000000000000000000000000000000000000000';
r = verifyPayment(tx.rawTxHex, tx.outputOffset, wrongPkh, testValue);
console.log(`  Result: ${r.pass ? 'PASS (unexpected!)' : 'FAIL (as expected)'}  reason=${r.reason}`);
if (r.pass) { console.error('SANITY FAILURE'); process.exit(1); }

// Test 5: wrong offset → must fail (points to mid-script garbage)
console.log('=== Test 5: wrong offset (should fail) ===');
r = verifyPayment(tx.rawTxHex, tx.outputOffset - 1, testPkh, testValue);
console.log(`  Result: ${r.pass ? 'PASS (unexpected!)' : 'FAIL (as expected)'}  reason=${r.reason}`);
if (r.pass) { console.error('SANITY FAILURE'); process.exit(1); }

console.log('');
console.log('✓ Payment verification algorithm correct for synthetic legacy P2PKH tx.');
console.log('✓ Rejects insufficient amount.');
console.log('✓ Rejects wrong pkh.');
console.log('✓ Rejects wrong offset.');
