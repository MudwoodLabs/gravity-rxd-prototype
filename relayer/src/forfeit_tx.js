/**
 * Build a Radiant forfeit() spending tx for an unused MakerCovenant UTXO.
 *
 * forfeit() path:
 *   require(tx.time >= claimDeadline);
 *   output[0] is P2PKH to makerPkh
 *   output[0].value >= totalPhotonsInOutput
 *
 * For claimDeadline=0, the time check is trivially satisfied. Note
 * OP_CHECKLOCKTIMEVERIFY requires the input's sequenceNumber to be
 * less than 0xFFFFFFFF; we use 0xFFFFFFFE.
 *
 * scriptSig layout: <selector=1 (OP_1)> <redeem script>
 */

const rxd = require('@radiant-core/radiantjs');

function buildForfeitTx({
  redeemHex, fundingTxid, fundingVout, fundingAmount,
  makerAddress, feeSats,
}) {
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
  tx.nLockTime = 0;  // satisfies require(tx.time >= 0)

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
