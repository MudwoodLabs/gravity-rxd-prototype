#!/usr/bin/env node
/**
 * Construct a Radiant spending transaction that unlocks a covenant UTXO
 * by providing specified witness data.
 *
 * The unlocking scriptSig is `<witness_1_push> <witness_2_push> ... <redeem_script_push>`.
 *
 * Usage:
 *   node build_spending_tx.js \
 *     --artifact <path> \
 *     --funding-txid <64-hex> \
 *     --funding-vout <int> \
 *     --funding-amount <sats> \
 *     --witnesses <hex1,hex2,...> \
 *     --to-address <radiant-address> \
 *     --fee-sats <int>
 *
 * Legacy single-header mode (kept for backward compat with verify_header):
 *     --header-hex <160-hex>    (same as --witnesses <hex>)
 *
 * Witness order matches the function parameter order in the contract.
 * For `function verify(bytes h1, bytes h2)`, pass `--witnesses h1hex,h2hex`.
 *
 * For P2SH contracts without signature checks, no signing is needed —
 * the scriptSig is just data pushes. The covenant is locked purely by
 * successful script evaluation.
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
                    'to-address', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error(`see script header for usage`);
    process.exit(2);
  }
  if (!args['witnesses'] && !args['header-hex']) {
    console.error('must provide --witnesses or --header-hex');
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

  // Collect witness buffers from either --witnesses (comma-separated hex list)
  // or legacy --header-hex (single 80-byte header).
  const witnessHexList = args['witnesses']
    ? args['witnesses'].split(',').map(s => s.trim())
    : [args['header-hex']];
  const witnessBufs = witnessHexList.map((hex, i) => {
    if (!hex) throw new Error(`witness ${i} is empty`);
    return Buffer.from(hex, 'hex');
  });
  console.log(`Witnesses: ${witnessBufs.length} item(s), sizes=${witnessBufs.map(b => b.length).join(',')}`);

  const fundingAmount = Number(args['funding-amount']);
  const fee = Number(args['fee-sats']);
  const outputAmount = fundingAmount - fee;
  if (outputAmount <= 0) {
    console.error(`funding amount ${fundingAmount} <= fee ${fee}; nothing to send`);
    process.exit(1);
  }

  // Construct the unlocking scriptSig:
  //   push <witness_1> push <witness_2> ... push <redeem_script>
  //
  // Witnesses are pushed in declaration order, so if the contract is
  //   function verify(bytes h1, bytes h2)
  // then the caller passes --witnesses h1hex,h2hex and we push h1 first
  // (lower on stack), h2 second (higher). The compiler's generated code
  // treats the last-pushed arg as top-of-stack.
  //
  // radiantjs Script.empty().add(buffer) pushes the buffer as a data push.
  let scriptSig = rxd.Script.empty();
  for (const w of witnessBufs) {
    scriptSig = scriptSig.add(w);
  }
  scriptSig = scriptSig.add(redeemScriptBuf);

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
  witnessBufs.forEach((w, i) => console.log(`  witness[${i}] size:    ${w.length} bytes`));
  console.log(`  full scriptSig:    ${scriptSig.toBuffer().length} bytes`);
  console.log('');
  console.log('Raw tx hex (hand to sendrawtransaction):');
  console.log(txHex);
  console.log('');
  console.log(`Txid (reversed):  ${tx.id}`);
}

main();
