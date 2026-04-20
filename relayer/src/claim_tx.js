/**
 * Build the Radiant claim() spending tx: spend MakerOffer and create a
 * MakerClaimed UTXO at a specific P2SH address.
 *
 * Requires Taker's privkey to produce a signature satisfying
 * MakerOffer.claim(sig takerSig) — prevents third-party state-advance
 * grief (audit 04 finding S3).
 *
 * claim() scriptSig: <takerSig+hashtype> <selector=1 = OP_1> <redeem script>
 *
 * Output[0]: P2SH wrapping the full MakerClaimed locking script, with
 * value = fundingAmount - feeSats. Must be >= MakerOffer's
 * totalPhotonsInOutput or claim will fail on-chain.
 */

const crypto = require('crypto');
const rxd = require('@radiant-core/radiantjs');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function buildClaimTx({
  offerRedeemHex, offerFundingTxid, offerFundingVout, offerFundingAmount,
  claimedRedeemHex, feeSats, takerPrivkeyWif, expectedClaimedCodeHash,
}) {
  if (!takerPrivkeyWif) {
    throw new Error(
      'takerPrivkeyWif required — MakerOffer.claim() now requires a ' +
      'Taker signature. Pass --taker-privkey-file to the CLI.'
    );
  }

  const privKey = new rxd.PrivateKey(takerPrivkeyWif);

  const offerRedeemBuf = Buffer.from(offerRedeemHex, 'hex');
  const offerRedeem = rxd.Script.fromBuffer(offerRedeemBuf);

  const claimedRedeemBuf = Buffer.from(claimedRedeemHex, 'hex');
  const claimedRedeem = rxd.Script.fromBuffer(claimedRedeemBuf);
  const claimedP2SHAddress = rxd.Address.payingTo(claimedRedeem);

  // Audit 05 F-13: before broadcasting the claim, verify the caller-supplied
  // `claimedRedeemHex` actually produces the P2SH scriptPubKey that
  // `MakerOffer.claim()` will test against. Matches the covenant's
  // `hash256(tx.outputs[0].codeScript) == expectedClaimedCodeHash` check
  // done on-chain — for P2SH deployments the codeScript is the full 23-byte
  // scriptPubKey `OP_HASH160 <20B hash160(redeem)> OP_EQUAL`.
  if (expectedClaimedCodeHash) {
    const scriptHash = hash160(claimedRedeemBuf);
    const claimedP2SHScriptPubKey = Buffer.concat([
      Buffer.from([0xa9, 0x14]),
      scriptHash,
      Buffer.from([0x87]),
    ]);
    const computed = hash256(claimedP2SHScriptPubKey).toString('hex');
    const expected = expectedClaimedCodeHash.toLowerCase();
    if (computed !== expected) {
      throw new Error(
        `claimedRedeemHex does not match expectedClaimedCodeHash.\n` +
        `  computed: ${computed}\n` +
        `  expected: ${expected}\n` +
        `The MakerOffer will refuse this claim on-chain. Check that the ` +
        `claimed redeem hex encodes the same constructor params (takerRadiantPkh, ` +
        `claimDeadline, etc.) that Maker committed to.`
      );
    }
  }

  const offerP2SHAddress = rxd.Address.payingTo(offerRedeem);
  const offerP2SHScriptPubKey = rxd.Script.buildScriptHashOut(offerP2SHAddress);

  const utxo = new rxd.Transaction.UnspentOutput({
    txId: offerFundingTxid,
    outputIndex: offerFundingVout,
    address: offerP2SHAddress.toString(),
    script: offerP2SHScriptPubKey.toHex(),
    satoshis: offerFundingAmount,
  });

  const outputAmount = offerFundingAmount - feeSats;
  if (outputAmount <= 0) throw new Error('fee exceeds funding amount');

  const tx = new rxd.Transaction();
  tx.from(utxo);
  tx.to(claimedP2SHAddress, outputAmount);

  // Sign input 0 over the redeem script (legacy P2SH sighash).
  const sighashType =
    rxd.crypto.Signature.SIGHASH_ALL | rxd.crypto.Signature.SIGHASH_FORKID;
  const sigBuf = rxd.Transaction.Sighash.sign(
    tx, privKey, sighashType, 0, offerRedeem, new rxd.crypto.BN(offerFundingAmount),
  );
  const sigWithHashtype = Buffer.concat([sigBuf.toBuffer(), Buffer.from([sighashType])]);

  // scriptSig: <takerSig> <selector=1 = OP_1> <offer redeem script>
  // Selector is the claim() function index (claim is index 1 — the second
  // function after cancel).
  const scriptSig = rxd.Script.empty()
    .add(sigWithHashtype)
    .add(rxd.Opcode.OP_1)
    .add(offerRedeemBuf);

  tx.inputs[0].setScript(scriptSig);
  tx.inputs[0].sequenceNumber = 0xffffffff;

  const txHex = tx.serialize({ disableAll: true });
  const txBytes = Buffer.from(txHex, 'hex');

  return {
    txHex,
    txId: tx.id,
    txSize: txBytes.length,
    scriptSigSize: scriptSig.toBuffer().length,
    offerP2SH: offerP2SHAddress.toString(),
    claimedP2SH: claimedP2SHAddress.toString(),
    fee: feeSats,
    outputAmount,
  };
}

module.exports = { buildClaimTx };
