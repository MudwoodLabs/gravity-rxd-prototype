#!/usr/bin/env node
/**
 * Construct a Radiant spending transaction that unlocks a covenant UTXO
 * by providing specified witness data.
 *
 * For verify_header.rxd, the witness is a single 80-byte Bitcoin header.
 * The unlocking scriptSig is: `<header_push> <redeem_script_push>`.
 *
 * Usage:
 *   node build_spending_tx.js \
 *     --artifact validation/verify_header.artifact.json \
 *     --funding-txid <64-hex> \
 *     --funding-vout <int> \
 *     --funding-amount <sats> \
 *     --header-hex <160-hex> \
 *     --to-address <radiant-address> \
 *     --fee-sats <int>
 *
 * Prints the signed raw hex (ready for `sendrawtransaction`).
 *
 * For P2SH contracts without signature checks, no signing is needed —
 * the scriptSig is just data pushes. This covenant takes no sig; the
 * output is locked purely by successful script evaluation.
 */

const fs = require('fs');
const rxd = require('@radiant-core/radiantjs');

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    args[k] = argv[i + 1];
  }
  const required = ['artifact', 'funding-txid', 'funding-vout', 'funding-amount',
                    'header-hex', 'to-address', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error(`see script header for usage`);
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs();

  const artifact = JSON.parse(fs.readFileSync(args.artifact, 'utf-8'));
  if (artifact.hex.includes('<')) {
    console.error('Artifact has unfilled constructor placeholders');
    process.exit(1);
  }

  const redeemScriptHex = artifact.hex;
  const redeemScriptBuf = Buffer.from(redeemScriptHex, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);

  const headerBuf = Buffer.from(args['header-hex'], 'hex');
  if (headerBuf.length !== 80) {
    console.error(`header-hex must be 80 bytes (160 hex chars), got ${headerBuf.length}`);
    process.exit(1);
  }

  const fundingAmount = Number(args['funding-amount']);
  const fee = Number(args['fee-sats']);
  const outputAmount = fundingAmount - fee;
  if (outputAmount <= 0) {
    console.error(`funding amount ${fundingAmount} <= fee ${fee}; nothing to send`);
    process.exit(1);
  }

  // Construct the unlocking scriptSig:
  //   push <header bytes>
  //   push <redeem script bytes>
  //
  // radiantjs Script.empty().add(buffer) pushes the buffer as a data push.
  const scriptSig = rxd.Script.empty()
    .add(headerBuf)
    .add(redeemScriptBuf);

  // Build the funding UTXO reference.
  const p2shAddress = rxd.Address.payingTo(redeemScript);
  const p2shScriptPubKey = rxd.Script.buildScriptHashOut(p2shAddress);

  const utxo = {
    txId: args['funding-txid'],
    outputIndex: Number(args['funding-vout']),
    address: p2shAddress.toString(),
    script: p2shScriptPubKey.toHex(),
    satoshis: fundingAmount,
  };

  // Build the spending tx.
  const tx = new rxd.Transaction();
  tx.from(new rxd.Transaction.UnspentOutput(utxo));
  tx.to(args['to-address'], outputAmount);

  // Set the scriptSig manually — no signing needed.
  tx.inputs[0].setScript(scriptSig);
  tx.inputs[0].sequenceNumber = 0xffffffff;

  const txHex = tx.serialize({ disableAll: true });
  const txSize = Buffer.from(txHex, 'hex').length;

  console.log(`=== Spending tx for ${artifact.contract} ===`);
  console.log(`Funding:         ${utxo.txId}:${utxo.outputIndex} (${fundingAmount} sats)`);
  console.log(`Fee:             ${fee} sats`);
  console.log(`Output:          ${outputAmount} sats to ${args['to-address']}`);
  console.log(`Tx size:         ${txSize} bytes`);
  console.log('');
  console.log('ScriptSig size:');
  console.log(`  redeem script:     ${redeemScriptBuf.length} bytes`);
  console.log(`  header witness:    ${headerBuf.length} bytes`);
  console.log(`  full scriptSig:    ${scriptSig.toBuffer().length} bytes`);
  console.log('');
  console.log('Raw tx hex (hand to sendrawtransaction):');
  console.log(txHex);
  console.log('');
  console.log(`Txid (reversed):  ${tx.id}`);
}

main();
