/**
 * Build the Radiant finalize() spending tx for a Gravity Maker covenant.
 *
 * Assembles the scriptSig in the order the covenant's finalize function
 * expects, from:
 *   - an SPV-proof JSON payload (from cli.js fetch-spv-proof)
 *   - the MakerClaimed UTXO reference (txid/vout/amount + full locking
 *     bytecode reconstructed with the Taker's specific state values)
 *   - the output position within the Bitcoin tx where the P2PKH to
 *     Maker's btcReceivePkh lives
 *   - the Taker's Radiant destination and fee
 *
 * finalize() signature (from gen_maker_covenant.js):
 *   finalize(bytes h1, bytes h2, ..., bytes hN, bytes branch,
 *            bytes rawTx, int outputOffset)
 *
 * scriptSig layout (pushed bottom-to-top; last push is TOP at exec):
 *   <h1> <h2> ... <hN> <branch> <rawTx> <outputOffset> <selector=0> <redeem script>
 *
 * The covenant is relay-driven: no signature needed. Any party with the
 * SPV proof can finalize. Output routing to the Taker's Radiant address
 * is enforced by the covenant's state (takerRadiantPkh), not by a sig.
 */

const rxd = require('@radiant-core/radiantjs');

function encodeIntMinimalScriptNum(n) {
  // Produce the CScriptNum byte representation for a non-negative int.
  // Callers push this as a data item; BIN2NUM inside the script reads it.
  if (n === 0) return Buffer.alloc(0); // OP_0 equivalent (empty push)
  const neg = n < 0;
  let v = Math.abs(n);
  const bytes = [];
  while (v > 0) { bytes.push(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  return Buffer.from(bytes);
}

/**
 * @param {Object} opts
 * @param {Object} opts.spvProof   — parsed JSON from fetch-spv-proof
 * @param {string} opts.redeemHex  — full MakerClaimed locking bytecode hex
 * @param {string} opts.fundingTxid
 * @param {number} opts.fundingVout
 * @param {number} opts.fundingAmount  — sats in the MakerClaimed UTXO
 * @param {number} opts.outputOffset   — byte offset of P2PKH output in rawTx
 * @param {string} opts.toAddress  — Taker's Radiant address
 * @param {number} opts.feeSats
 *
 * Returns an object with raw hex, size, txid, and breakdown.
 */
function buildFinalizeTx(opts) {
  const {
    spvProof, redeemHex, fundingTxid, fundingVout, fundingAmount,
    outputOffset, toAddress, feeSats,
  } = opts;

  if (!spvProof.merkle_root_matches) {
    throw new Error('spv proof does not pass Merkle root check; refusing to build');
  }
  if (!spvProof.raw_tx_hashes_to_txid) {
    throw new Error('spv proof rawTx does not hash256 to its txid (segwit/taproot?); ' +
                    'covenant will reject. Strip witness data first.');
  }

  const redeemScriptBuf = Buffer.from(redeemHex, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);

  // Validate that outputOffset points at a recognized output type in rawTx.
  // Accepts P2PKH, P2WPKH, P2SH, P2TR (matches the multi-type covenant).
  const rawTxBuf = Buffer.from(spvProof.raw_tx, 'hex');
  if (rawTxBuf.length < outputOffset + 22) {
    throw new Error(`outputOffset ${outputOffset} beyond rawTx length ${rawTxBuf.length}`);
  }
  const prefix4 = rawTxBuf.slice(outputOffset + 8, outputOffset + 12).toString('hex');
  const prefix3 = rawTxBuf.slice(outputOffset + 8, outputOffset + 11).toString('hex');
  const knownPrefixes = {
    '1976a914': 'P2PKH',
    '160014':   'P2WPKH',
    '17a914':   'P2SH',
    '225120':   'P2TR',
  };
  const matched = knownPrefixes[prefix4] || knownPrefixes[prefix3];
  if (!matched) {
    throw new Error(
      `output at offset ${outputOffset} is not a recognized payment type. ` +
      `prefix(4)=${prefix4}, prefix(3)=${prefix3}. Expected one of: ` +
      Object.entries(knownPrefixes).map(([k,v]) => `${v}=${k}`).join(', ')
    );
  }

  // Assemble witnesses in the covenant's declared parameter order:
  //   h1, h2, ..., hN (headers), branch, rawTx, outputOffset, selector=0
  let scriptSig = rxd.Script.empty();
  for (const headerHex of spvProof.headers) {
    scriptSig = scriptSig.add(Buffer.from(headerHex, 'hex'));
  }
  scriptSig = scriptSig.add(Buffer.from(spvProof.branch, 'hex'));
  scriptSig = scriptSig.add(rawTxBuf);
  scriptSig = scriptSig.add(encodeIntMinimalScriptNum(outputOffset));
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
    witnessCount: spvProof.headers.length + 3, // headers + branch + rawTx + offset
    p2shAddress: p2shAddress.toString(),
    fundingAmount,
    fee: feeSats,
    outputAmount,
  };
}

module.exports = { buildFinalizeTx };
