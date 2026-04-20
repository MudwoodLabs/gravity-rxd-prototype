/**
 * Build a Radiant forfeit() spending tx for an unused MakerCovenant UTXO.
 *
 * forfeit() path:
 *   require(tx.time >= claimDeadline);
 *   output[0] is P2PKH to makerPkh
 *   output[0].value >= totalPhotonsInOutput
 *
 * The covenant now rejects claimDeadline < 1735686400 (2025-01-01) so the
 * forfeit path can never be open from block 1 — this closes the
 * finalize/forfeit race that audit 04 flagged as the biggest game-theoretic
 * defect (S1). Takers must allow enough time for BTC to confirm + SPV
 * proof generation + Radiant finalization before claimDeadline, typically
 * 24+ hours.
 *
 * OP_CHECKLOCKTIMEVERIFY requires the input's sequenceNumber to be less
 * than 0xFFFFFFFF; we use 0xFFFFFFFE.
 *
 * scriptSig layout: <selector=1 (OP_1)> <redeem script>
 */

const rxd = require('@radiant-core/radiantjs');

function buildForfeitTx({
  redeemHex, fundingTxid, fundingVout, fundingAmount,
  makerAddress, feeSats, claimDeadline,
}) {
  if (claimDeadline === undefined || claimDeadline === null) {
    throw new Error(
      'claimDeadline required — forfeit tx must set nLockTime >= the ' +
      'covenant\'s claimDeadline for OP_CHECKLOCKTIMEVERIFY to pass.'
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (claimDeadline > now) {
    throw new Error(
      `claimDeadline ${claimDeadline} is ${claimDeadline - now}s in the ` +
      `future; forfeit cannot run yet`
    );
  }
  const redeemScriptBuf = Buffer.from(redeemHex, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);

  const p2shAddress = rxd.Address.payingTo(redeemScript);
  const p2shScriptPubKey = rxd.Script.buildScriptHashOut(p2shAddress);

  const utxo = new rxd.Transaction.UnspentOutput({
    txId: fundingTxid,
    outputIndex: fundingVout,
    address: p2shAddress.toString(),
    script: p2shScriptPubKey.toHex(),
    satoshis: fundingAmount,
  });

  const outputAmount = fundingAmount - feeSats;
  if (outputAmount <= 0) throw new Error('fee exceeds funding amount');

  const tx = new rxd.Transaction();
  tx.from(utxo);
  tx.to(makerAddress, outputAmount);

  // scriptSig: OP_1 (selector=1 for forfeit) + redeem script
  const scriptSig = rxd.Script.empty()
    .add(rxd.Opcode.OP_1)
    .add(redeemScriptBuf);

  tx.inputs[0].setScript(scriptSig);
  // Must be < 0xFFFFFFFF for OP_CHECKLOCKTIMEVERIFY to pass
  tx.inputs[0].sequenceNumber = 0xFFFFFFFE;
  // nLockTime must be >= claimDeadline for the covenant's
  // require(tx.time >= claimDeadline) to pass. Use claimDeadline itself —
  // no reason to lock further out.
  tx.nLockTime = claimDeadline;

  const txHex = tx.serialize({ disableAll: true });
  const txBytes = Buffer.from(txHex, 'hex');

  return {
    txHex,
    txId: tx.id,
    txSize: txBytes.length,
    p2shAddress: p2shAddress.toString(),
    fee: feeSats,
    outputAmount,
  };
}

module.exports = { buildForfeitTx };
