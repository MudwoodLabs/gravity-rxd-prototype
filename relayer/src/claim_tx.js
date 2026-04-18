/**
 * Build the Radiant claim() spending tx: spend MakerOfferSimple and
 * create a MakerClaimed UTXO at a specific P2SH address.
 *
 * claim() scriptSig: <selector=1> <redeem script>
 * No signature required — claim is permissionless; anyone can claim by
 * creating an output meeting the value threshold.
 *
 * Output[0]: P2SH wrapping the full MakerClaimed locking script, with
 * value = fundingAmount - feeSats. Must be >= MakerOfferSimple's
 * photonsOffered or claim will fail on-chain.
 */

const rxd = require('@radiant-core/radiantjs');

function buildClaimTx({
  offerRedeemHex, offerFundingTxid, offerFundingVout, offerFundingAmount,
  claimedRedeemHex, feeSats,
}) {
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

  // scriptSig: <selector=1 = OP_1> <offer redeem script>
  // OP_1 is a single-byte opcode (0x51), emitted by Script.empty().add(1) or
  // by using radiantjs's Opcode.OP_1 directly. Easiest: use add() with a
  // number, which radiantjs interprets as a minimal-int push.
  const scriptSig = rxd.Script.empty()
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
