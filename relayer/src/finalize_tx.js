/**
 * Build the Radiant finalize() spending tx for a Gravity Maker covenant.
 *
 * Assembles the scriptSig in the order the covenant's finalize function
 * expects, from:
 *   - an SPV-proof JSON payload (from cli.js fetch-spv-proof)
 *   - the MakerClaimed UTXO reference (txid/vout/amount + full locking
 *     bytecode reconstructed with the Taker's specific state values)
 *   - the Taker's Radiant destination and fee
 *
 * finalize() signature (from gen_maker_covenant.js):
 *   finalize(bytes h1, bytes h2, ..., bytes hN, bytes branch, bytes rawTx)
 *
 * scriptSig layout (pushed bottom-to-top; last push is TOP at exec):
 *   <h1> <h2> ... <hN> <branch> <rawTx> <selector=0> <redeem script>
 *
 * The covenant now CONSTRAINS the rawTx to a 1-input segwit layout so the
 * payment output position is a known constant (47). This eliminates the
 * attacker-chosen-outputOffset bypass flagged by audit 03 finding C2.
 *
 * Taker must therefore:
 *   - use a single segwit (P2WPKH or P2TR) UTXO as the Bitcoin input
 *   - place the Maker payment as output[0] of the BTC tx
 *
 * The covenant is relay-driven on the Radiant side: no Radiant signature
 * needed. Output routing to the Taker's Radiant address is enforced by
 * the covenant's state (takerRadiantPkh).
 */

const rxd = require('@radiant-core/radiantjs');
const path = require('path');
const validators = require(path.join(__dirname, '..', '..', 'reference', 'validators'));

/**
 * @param {Object} opts
 * @param {Object} opts.spvProof   — parsed JSON from fetch-spv-proof
 * @param {string} opts.redeemHex  — full MakerClaimed locking bytecode hex
 * @param {string} opts.fundingTxid
 * @param {number} opts.fundingVout
 * @param {number} opts.fundingAmount  — sats in the MakerClaimed UTXO
 * @param {string} opts.toAddress  — Taker's Radiant address
 * @param {number} opts.feeSats
 *
 * Returns an object with raw hex, size, txid, and breakdown.
 */
function buildFinalizeTx(opts) {
  const {
    spvProof, redeemHex, fundingTxid, fundingVout, fundingAmount,
    toAddress, feeSats,
  } = opts;

  if (!spvProof.merkle_root_matches) {
    throw new Error('spv proof does not pass Merkle root check; refusing to build');
  }
  if (!spvProof.raw_tx_hashes_to_txid) {
    throw new Error('spv proof rawTx does not hash256 to its txid (segwit/taproot?); ' +
                    'covenant will reject. Strip witness data first.');
  }

  // Per-invariant pre-flight: the SPV proof JSON records validation
  // results from fetch-spv-proof, but the proof could have been generated
  // without covenant params (anchor, nBits, payment). If the caller passes
  // expected values here we re-check them independently — the goal is
  // "buildFinalizeTx is the last chance to catch a doomed proof before
  // Radiant fees are burned" (audit 05 F-2 residual).
  if (opts.expectedNBits) {
    const nb = validators.verifyNBitsMatch(
      spvProof.headers,
      opts.expectedNBits,
      opts.expectedNBitsNext,
    );
    if (!nb.pass) {
      throw new Error(`expectedNBits mismatch in SPV proof: ${nb.reason}`);
    }
  }
  if (opts.anchorHash) {
    const a = validators.verifyAnchor(spvProof.headers[0], opts.anchorHash);
    if (!a.pass) {
      throw new Error(`chain anchor mismatch: h1.prevHash=${a.got}, expected=${opts.anchorHash}`);
    }
  }
  if (opts.btcReceiveHash && opts.btcSatoshis !== undefined && opts.btcReceiveType) {
    // outputOffset is dynamic based on Taker-input shape (47 for native
    // segwit, 70 for P2SH-P2WPKH). Derive it from verifyTxStructure.
    const pay = validators.verifyPayment(
      spvProof.raw_tx, struct.outputOffset,
      opts.btcReceiveHash, opts.btcSatoshis, opts.btcReceiveType,
    );
    if (!pay.pass) {
      throw new Error(`payment output check failed: ${pay.reason}`);
    }
  }

  const redeemScriptBuf = Buffer.from(redeemHex, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);

  // Structural check: the covenant only accepts a 1-input segwit tx with
  // output[0] at byte 47. Fail early here with a specific error rather than
  // letting the covenant reject with an opaque script-verification failure.
  const struct = validators.verifyTxStructure(spvProof.raw_tx);
  if (!struct.pass) {
    throw new Error(
      `rawTx does not meet the covenant's structural constraint: ${struct.reason}. ` +
      `Taker must use a single segwit (P2WPKH/P2TR) UTXO, and place the Maker ` +
      `payment as output[0].`
    );
  }

  // Assemble witnesses in the covenant's declared parameter order:
  //   h1, h2, ..., hN (headers), branch, rawTx, selector=0
  let scriptSig = rxd.Script.empty();
  for (const headerHex of spvProof.headers) {
    scriptSig = scriptSig.add(Buffer.from(headerHex, 'hex'));
  }
  scriptSig = scriptSig.add(Buffer.from(spvProof.branch, 'hex'));
  scriptSig = scriptSig.add(Buffer.from(spvProof.raw_tx, 'hex'));
  // finalize is function index 0 → selector 0 → OP_0 (empty push)
  scriptSig = scriptSig.add(Buffer.alloc(0));
  scriptSig = scriptSig.add(redeemScriptBuf);

  // Build the spending tx. The UTXO is P2SH-wrapped around our redeem script.
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
  tx.to(toAddress, outputAmount);
  tx.inputs[0].setScript(scriptSig);
  tx.inputs[0].sequenceNumber = 0xffffffff;

  const txHex = tx.serialize({ disableAll: true });
  const txBytes = Buffer.from(txHex, 'hex');

  return {
    txHex,
    txId: tx.id,
    txSize: txBytes.length,
    scriptSigSize: scriptSig.toBuffer().length,
    redeemScriptSize: redeemScriptBuf.length,
    witnessCount: spvProof.headers.length + 2, // headers + branch + rawTx
    p2shAddress: p2shAddress.toString(),
    fundingAmount,
    fee: feeSats,
    outputAmount,
  };
}

module.exports = { buildFinalizeTx };
