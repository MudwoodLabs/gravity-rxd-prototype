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

const rxd = require('@radiant-core/radiantjs');

function buildClaimTx({
  offerRedeemHex, offerFundingTxid, offerFundingVout, offerFundingAmount,
  claimedRedeemHex, feeSats, takerPrivkeyWif,
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
