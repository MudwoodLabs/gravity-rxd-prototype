/**
 * Red-Team Attack Builder for Gravity BTC↔RXD Covenant
 * Builds attack transactions for 4 test scenarios.
 */

const crypto = require('crypto');
const fs = require('fs');
const rxd = require('@radiant-core/radiantjs');
const { buildFinalizeTx } = require('./src/finalize_tx.js');
const { buildForfeitTx } = require('./src/forfeit_tx.js');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

// ============================================================
// Common constants from the live session
// ============================================================
const UTXO_ATTEMPT1 = {
  txid: '60dbbdd677e9c263fa361513cef66da4e12c52c32682c307c94effc9489648b9',
  vout: 0,
  amount: 147000000, // 1.47 RXD in photons (satoshis)
};
const CLAIM_DEADLINE_ATT1 = 1776889595; // ~2026-04-22 20:09 UTC
const MAKER_WIF = fs.readFileSync('/tmp/maker-rxd.wif', 'utf8').trim();
const MAKER_PRIV = new rxd.PrivateKey(MAKER_WIF);
const MAKER_ADDR = MAKER_PRIV.toPublicKey().toAddress().toString();
const TAKER_ADDR = '1JArrpvMqWyf7EMVVQzdgqXnHcgwZ71C8p'; // from finalize tx vout[0]

const proof2 = JSON.parse(fs.readFileSync('/tmp/spv-proof2.json', 'utf8'));
const redeemHex1 = fs.readFileSync('/tmp/claimed_redeem.hex', 'utf8').trim();
const redeemHex2 = fs.readFileSync('/tmp/claimed_redeem2.hex', 'utf8').trim();

console.log(`Maker addr: ${MAKER_ADDR}`);
console.log(`Taker addr: ${TAKER_ADDR}`);
console.log(`Attempt-1 UTXO: ${UTXO_ATTEMPT1.txid}:${UTXO_ATTEMPT1.vout} (${UTXO_ATTEMPT1.amount} photons)`);
console.log(`Proof2 valid: merkle_root_matches=${proof2.merkle_root_matches}, header_count=${proof2.header_count}`);
console.log('');

// ============================================================
// ATTACK 1: Tampered Merkle Branch
// Take the valid proof2, flip one byte of the branch, attempt finalize
// on the live attempt-1 UTXO.
// ============================================================
console.log('='.repeat(60));
console.log('ATTACK 1: Tampered Merkle Branch');
console.log('='.repeat(60));
{
  const tamperedProof = JSON.parse(JSON.stringify(proof2));
  const branchBuf = Buffer.from(tamperedProof.branch, 'hex');
  
  // Tamper byte index 5 of the Merkle branch (inside level-0 sibling)
  // Level-0 entry = bytes [0..32]: dir(1B) + sibling(32B)
  // Byte 5 is 4 bytes into the level-0 sibling
  const origByte = branchBuf[5];
  branchBuf[5] ^= 0xff;
  console.log(`Branch tamper: byte[5] 0x${origByte.toString(16).padStart(2,'0')} -> 0x${branchBuf[5].toString(16).padStart(2,'0')}`);
  tamperedProof.branch = branchBuf.toString('hex');

  try {
    const result = buildFinalizeTx({
      spvProof: tamperedProof,
      redeemHex: redeemHex1,
      fundingTxid: UTXO_ATTEMPT1.txid,
      fundingVout: UTXO_ATTEMPT1.vout,
      fundingAmount: UTXO_ATTEMPT1.amount,
      toAddress: TAKER_ADDR,
      feeSats: 10000,
    });
    console.log('TX BUILT (builder did not catch tampered branch - expected)');
    console.log(`  txid: ${result.txId}`);
    console.log(`  size: ${result.txSize} bytes`);
    fs.writeFileSync('/tmp/attack1.hex', result.txHex);
    console.log('  Written to /tmp/attack1.hex');
  } catch (e) {
    console.log(`BUILD REJECTED by builder: ${e.message}`);
    fs.writeFileSync('/tmp/attack1.hex', '');
  }
}

console.log('');

// ============================================================
// ATTACK 2: Fake Payment — wrong BTC recipient
// Construct a fake BTC tx where output[0] goes to a DIFFERENT P2WPKH hash,
// embed it in a finalize scriptSig. The covenant checks
// `hash == btcReceiveHash` (the maker's receive PKH = ebd690cf...)
// ============================================================
console.log('='.repeat(60));
console.log('ATTACK 2: Fake Payment — Wrong BTC Recipient');
console.log('='.repeat(60));
{
  // Clone the valid proof
  const fakeProof = JSON.parse(JSON.stringify(proof2));
  
  // Parse the legitimate raw_tx and swap the P2WPKH hash in output[0]
  // Raw tx layout (native segwit, P2WPKH input):
  //   version(4) + inputCount(1=0x01) + outpoint(36) + scriptSigLen(1=0x00) + sequence(4)
  //   + outputCount(1) + [output[0]: value(8) + scriptLen(1=0x16) + 0x0014 + pkh(20) + ...]
  // Output[0] starts at byte 47 (native segwit path)
  const rawTxBuf = Buffer.from(fakeProof.raw_tx, 'hex');
  console.log(`Original raw_tx length: ${rawTxBuf.length} bytes`);
  
  // Output[0] at offset 47: value(8) + 0x16(1) + 0x0014(2) + pkh(20) = 31 bytes
  // The pkh starts at offset 47 + 8 + 1 + 2 = 58
  const PKH_OFFSET = 58;
  const originalPkh = rawTxBuf.slice(PKH_OFFSET, PKH_OFFSET + 20);
  console.log(`Original BTC output pkh (ebd690cf...): ${originalPkh.toString('hex')}`);
  
  // Replace with attacker's chosen hash (all 0xAA bytes = obviously wrong address)
  const fakePkh = Buffer.alloc(20, 0xaa);
  fakePkh.copy(rawTxBuf, PKH_OFFSET);
  console.log(`Fake BTC output pkh: ${fakePkh.toString('hex')}`);
  
  // Update the proof with the tampered raw tx
  fakeProof.raw_tx = rawTxBuf.toString('hex');
  
  // Recompute fake txid (hash256 of fake raw tx)
  const fakeTxid = hash256(rawTxBuf).reverse().toString('hex');
  console.log(`Fake txid: ${fakeTxid}`);
  console.log(`Original txid: ${proof2.txid}`);
  
  // The builder checks: hash256(raw_tx) == txid (from proof).
  // Since we tampered raw_tx but kept original txid, this WILL fail at the builder.
  // We need to also update the txid in the proof AND rebuild the Merkle branch to match.
  // Since we can't do that (we'd need to fake a BTC block), we:
  //   (a) Try with mismatched txid to show the builder catches it
  //   (b) Then explain what the covenant would catch even if the builder was bypassed

  try {
    buildFinalizeTx({
      spvProof: fakeProof,
      redeemHex: redeemHex1,
      fundingTxid: UTXO_ATTEMPT1.txid,
      fundingVout: UTXO_ATTEMPT1.vout,
      fundingAmount: UTXO_ATTEMPT1.amount,
      toAddress: TAKER_ADDR,
      feeSats: 10000,
    });
    console.log('ERROR: Builder should have rejected txid mismatch!');
  } catch (e) {
    console.log(`Builder correctly rejected: ${e.message}`);
  }
  
  // Bypass: update the fake txid in the proof too, and set merkle_root_matches=true
  // to force-build the tx (bypassing the off-chain preflight)
  fakeProof.txid = fakeTxid;
  // The Merkle branch is now wrong (points to original txid), so we also need to
  // craft a new branch. Since we can't forge real PoW, demonstrate the construction
  // with a fake (zeroed) branch to show WHICH covenant check would fire:
  // The covenant will first compute hash256(rawTx) and walk the Merkle tree —
  // with a tampered raw_tx the root won't match any of h1..h6's merkleRoot.
  
  // Build tx without Merkle check (builder doesn't verify branch off-chain)
  try {
    const result = buildFinalizeTx({
      spvProof: fakeProof,
      redeemHex: redeemHex1,
      fundingTxid: UTXO_ATTEMPT1.txid,
      fundingVout: UTXO_ATTEMPT1.vout,
      fundingAmount: UTXO_ATTEMPT1.amount,
      toAddress: TAKER_ADDR,
      feeSats: 10000,
    });
    console.log(`TX BUILT with fake payment hash (Merkle branch invalid — on-chain check will catch it)`);
    console.log(`  txid: ${result.txId}`);
    console.log(`  size: ${result.txSize} bytes`);
    fs.writeFileSync('/tmp/attack2.hex', result.txHex);
    console.log('  Written to /tmp/attack2.hex');
  } catch (e) {
    console.log(`Builder rejected attack2 tx: ${e.message}`);
    fs.writeFileSync('/tmp/attack2.hex', '');
  }
}

console.log('');

// ============================================================
// ATTACK 3: Early Forfeit (before claimDeadline)
// Attempt to forfeit while claimDeadline is still in the future.
// ============================================================
console.log('='.repeat(60));
console.log('ATTACK 3: Early Forfeit (Before Deadline)');
console.log('='.repeat(60));
{
  const now = Math.floor(Date.now() / 1000);
  const deadline = CLAIM_DEADLINE_ATT1;
  console.log(`Current time: ${now} (${new Date(now*1000).toISOString()})`);
  console.log(`claimDeadline: ${deadline} (${new Date(deadline*1000).toISOString()})`);
  console.log(`Time until deadline: ${deadline - now}s (${((deadline-now)/3600).toFixed(1)}h)`);
  
  try {
    buildForfeitTx({
      redeemHex: redeemHex1,
      fundingTxid: UTXO_ATTEMPT1.txid,
      fundingVout: UTXO_ATTEMPT1.vout,
      fundingAmount: UTXO_ATTEMPT1.amount,
      makerAddress: MAKER_ADDR,
      feeSats: 10000,
      claimDeadline: deadline,
    });
    console.log('ERROR: Builder should have rejected early forfeit!');
  } catch (e) {
    console.log(`Builder correctly rejected early forfeit: ${e.message}`);
    fs.writeFileSync('/tmp/attack3.hex', '');
  }
  
  // BYPASS ATTEMPT: Manually build the forfeit tx ignoring the deadline check
  // to demonstrate what the on-chain covenant would see
  console.log('\nBypass: manually building forfeit tx with nLockTime=now (before deadline)...');
  try {
    const redeemScriptBuf = Buffer.from(redeemHex1, 'hex');
    const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);
    const p2shAddress = rxd.Address.payingTo(redeemScript);
    const p2shScriptPubKey = rxd.Script.buildScriptHashOut(p2shAddress);
    
    const utxo = new rxd.Transaction.UnspentOutput({
      txId: UTXO_ATTEMPT1.txid,
      outputIndex: UTXO_ATTEMPT1.vout,
      address: p2shAddress.toString(),
      script: p2shScriptPubKey.toHex(),
      satoshis: UTXO_ATTEMPT1.amount,
    });
    
    const tx = new rxd.Transaction();
    tx.from(utxo);
    tx.to(MAKER_ADDR, UTXO_ATTEMPT1.amount - 10000);
    
    // forfeit selector = OP_1
    const scriptSig = rxd.Script.empty()
      .add(rxd.Opcode.OP_1)
      .add(redeemScriptBuf);
    
    tx.inputs[0].setScript(scriptSig);
    tx.inputs[0].sequenceNumber = 0xFFFFFFFE; // must be < 0xFFFFFFFF for CLTV
    tx.nLockTime = now; // BEFORE the claimDeadline — this is the attack
    
    const txHex = tx.serialize({ disableAll: true });
    console.log(`  Manual forfeit tx built (nLockTime=${now}, but deadline=${deadline})`);
    console.log(`  txid: ${tx.id}`);
    console.log(`  size: ${Buffer.from(txHex,'hex').length} bytes`);
    fs.writeFileSync('/tmp/attack3.hex', txHex);
    console.log('  Written to /tmp/attack3.hex');
  } catch (e) {
    console.log(`  Manual build also failed: ${e.message}`);
  }
}

console.log('');

// ============================================================
// ATTACK 4: SPV Proof Replay
// The finalize tx 23a584ee... is already in a block.
// We want to broadcast it again (raw replay) AND try to use the same
// SPV proof for a different UTXO (construct & explain rejection).
// ============================================================
console.log('='.repeat(60));
console.log('ATTACK 4: SPV Proof Replay');
console.log('='.repeat(60));
{
  console.log('Replay tx: 23a584eed5d5c88870512b9de19750151c6707e7acb15e76e426ff57212c244e');
  console.log('This tx is already in block. Broadcasting it again...');
  // We'll do the actual broadcast in the SSH call below.
  // Here, just explain the reuse-against-different-UTXO scenario.
  console.log('\nSPV proof reuse scenario: using proof2 against attempt-1 UTXO');
  console.log(`  proof2 BTC txid: ${proof2.txid}`);
  console.log(`  proof2 raw_tx output[0] recipient: ebd690cf206075df52f28b27020629e31ab4a891`);
  console.log(`  Attempt-1 UTXO P2SH addr: 3PZj6TvkcCqTJowXw2iy1gmcAX7KJK5Fr6`);
  console.log(`  Attempt-1 redeem has same btcReceiveHash (ebd690cf...) — same Maker`);
  
  // Attempt to build a finalize tx for attempt-1 UTXO using proof2
  try {
    const result = buildFinalizeTx({
      spvProof: proof2,
      redeemHex: redeemHex1,  // attempt-1 claimed redeem
      fundingTxid: UTXO_ATTEMPT1.txid,
      fundingVout: UTXO_ATTEMPT1.vout,
      fundingAmount: UTXO_ATTEMPT1.amount,
      toAddress: TAKER_ADDR,
      feeSats: 10000,
    });
    console.log(`\nTX BUILT: Proof2 used against attempt-1 UTXO`);
    console.log(`  txid: ${result.txId}`);
    console.log(`  size: ${result.txSize} bytes`);
    fs.writeFileSync('/tmp/attack4_proof_reuse.hex', result.txHex);
    console.log('  Written to /tmp/attack4_proof_reuse.hex');
  } catch (e) {
    console.log(`\nBuilder rejected proof2 against attempt-1 UTXO: ${e.message}`);
    fs.writeFileSync('/tmp/attack4_proof_reuse.hex', '');
  }
}

console.log('\nDone. Check /tmp/attack*.hex for transaction hex files.');
