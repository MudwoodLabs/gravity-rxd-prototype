#!/usr/bin/env node
/**
 * Construct a signed spending tx that exercises the cancel() path of
 * MakerOffer.
 *
 * scriptSig layout:
 *   <sig>        (71-72 bytes, BCH-style ALL|FORKID hashtype)
 *   <selector 0> (1 byte 0x00 pushed explicitly, so OP_NUMEQUAL against 0 matches)
 *   <redeem script>
 *
 * Usage:
 *   node build_cancel_tx.js \
 *     --artifact <path>               # MakerOffer instantiated artifact
 *     --funding-txid <64-hex>
 *     --funding-vout <int>
 *     --funding-amount <sats>
 *     --privkey-file <path>           # WIF file (single line)
 *     --to-address <address>
 *     --fee-sats <int>
 */

const fs = require('fs');
const rxd = require('/home/eric/apps/gravity-rxd-prototype/validation/node_modules/@radiant-core/radiantjs');

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    args[k] = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs();
  const artifact = JSON.parse(fs.readFileSync(args.artifact, 'utf-8'));

  const redeemScriptBuf = Buffer.from(artifact.hex, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);

  const wif = fs.readFileSync(args['privkey-file'], 'utf-8').trim();
  const privKey = rxd.PrivateKey.fromWIF(wif);

  const fundingAmount = Number(args['funding-amount']);
  const fee = Number(args['fee-sats']);
  const outputAmount = fundingAmount - fee;

  // Construct the P2SH UTXO reference.
  const p2shAddress = rxd.Address.payingTo(redeemScript);
  const p2shScriptPubKey = rxd.Script.buildScriptHashOut(p2shAddress);

  const utxo = new rxd.Transaction.UnspentOutput({
    txId: args['funding-txid'],
    outputIndex: Number(args['funding-vout']),
    address: p2shAddress.toString(),
    script: p2shScriptPubKey.toHex(),
    satoshis: fundingAmount,
  });

  const tx = new rxd.Transaction();
  tx.from(utxo);
  tx.to(args['to-address'], outputAmount);

  // The signature hashes the tx with scriptSig replaced by the redeem script
  // (for legacy P2SH signing). radiantjs's Transaction.Signature provides
  // the machinery.
  const sighashType =
    rxd.crypto.Signature.SIGHASH_ALL | rxd.crypto.Signature.SIGHASH_FORKID;

  // Manually compute the sighash for input 0 over the redeem script.
  const sigBuf = rxd.Transaction.Sighash.sign(
    tx, privKey, sighashType, 0, redeemScript, new rxd.crypto.BN(fundingAmount),
  );
  // sigBuf from radiantjs is the DER-encoded sig WITHOUT the hashtype byte.
  // Append the hashtype.
  const sigWithHashtype = Buffer.concat([sigBuf.toBuffer(), Buffer.from([sighashType])]);

  // Build the scriptSig: <sig> <selector=0> <redeem script>
  //
  // SCRIPT_VERIFY_MINIMALDATA requires canonical encoding for small numbers:
  // value 0 MUST be OP_0 (empty push), not a 1-byte 0x00 push. Using an
  // empty buffer produces OP_0.
  const scriptSig = rxd.Script.empty()
    .add(sigWithHashtype)
    .add(Buffer.alloc(0))
    .add(redeemScriptBuf);

  tx.inputs[0].setScript(scriptSig);
  tx.inputs[0].sequenceNumber = 0xffffffff;

  const txHex = tx.serialize({ disableAll: true });
  const txBytes = Buffer.from(txHex, 'hex');

  console.log(`=== cancel() spending tx for ${artifact.contract} ===`);
  console.log(`Funding:         ${utxo.txId}:${utxo.outputIndex} (${fundingAmount} sats)`);
  console.log(`Fee:             ${fee} sats`);
  console.log(`Output:          ${outputAmount} sats to ${args['to-address']}`);
  console.log(`Tx size:         ${txBytes.length} bytes`);
  console.log('');
  console.log('ScriptSig components:');
  console.log(`  sig+hashtype:   ${sigWithHashtype.length} bytes`);
  console.log(`  selector:       OP_0 (empty push, minimal encoding for value 0)`);
  console.log(`  redeem script:  ${redeemScriptBuf.length} bytes`);
  console.log(`  full scriptSig: ${scriptSig.toBuffer().length} bytes`);
  console.log('');
  console.log('Raw tx hex:');
  console.log(txHex);
  console.log('');
  console.log(`Txid: ${tx.id}`);
}

main();
