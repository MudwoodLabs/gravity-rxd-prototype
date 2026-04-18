#!/usr/bin/env node
/**
 * gravity-relayer CLI
 *
 * Current commands (minimum viable set):
 *
 *   gravity-relayer fetch-spv-proof --txid <btc-txid> [--headers N]
 *       Fetches the SPV components needed to unlock a Gravity finalize():
 *         - N consecutive Bitcoin headers starting at the block containing txid
 *         - raw tx hex
 *         - Merkle branch in covenant format
 *         - computed root + cross-check against header.merkleRoot
 *       Prints everything as JSON. Downstream: pipe into a finalize
 *       tx builder.
 *
 *   gravity-relayer validate-proof --txid <btc-txid>
 *       Same as fetch-spv-proof but only prints pass/fail of the
 *       off-chain Merkle verification, without emitting witness data.
 *
 * Future commands (not yet implemented):
 *   build-finalize-tx    — assemble the Radiant spending tx
 *   broadcast            — send to Radiant RPC
 *   claim                — drive a Taker-side claim() transition
 */

const fs = require('fs');
const { execSync } = require('child_process');
const btc = require('./btc');
const proof = require('./proof');
const { buildFinalizeTx } = require('./finalize_tx');
const { buildClaimTx } = require('./claim_tx');

function parseArgs() {
  const argv = process.argv.slice(3); // skip: node cli.js <command>
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    args[k] = argv[i + 1];
  }
  return args;
}

async function cmdFetchSpvProof() {
  const args = parseArgs();
  if (!args.txid) {
    console.error('--txid required');
    process.exit(2);
  }
  const N = parseInt(args.headers || '6', 10);

  const meta = await btc.getTxMeta(args.txid);
  if (!meta.status || !meta.status.confirmed) {
    console.error(`tx ${args.txid} not yet confirmed`);
    process.exit(1);
  }

  const startHeight = meta.status.block_height;
  const headers = await btc.getHeaderChain(startHeight, N);
  const rawTx = await btc.getRawTx(args.txid);
  const mp = await btc.getMerkleProof(args.txid);
  const branch = proof.buildBranch(mp.merkle, mp.pos);

  // Cross-check off-chain via the branch (starting from the known txid)
  const computedRoot = proof.computeRoot(args.txid, branch);
  const expectedRoot = proof.extractMerkleRoot(headers[0]);
  const match = computedRoot.equals(expectedRoot);

  // Sanity check: does hash256(raw_tx) == txid? Segwit/Taproot txs serialize
  // with witness data and their hash256 gives the wtxid, not the txid. The
  // covenant on-chain computes hash256(raw_tx) to derive the leaf — so if
  // this doesn't match, the on-chain proof will fail. Users must supply the
  // non-witness serialization for segwit txs.
  const crypto = require('crypto');
  const rawTxHash = crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(Buffer.from(rawTx, 'hex')).digest()
  ).digest();
  const txidLE = Buffer.from(args.txid, 'hex').reverse();
  const rawTxHashesToTxid = rawTxHash.equals(txidLE);

  const warnings = [];
  if (!rawTxHashesToTxid) {
    warnings.push(
      'raw_tx does NOT hash256 to txid — likely a segwit/taproot tx. ' +
      'The on-chain covenant will reject this; production Takers must construct ' +
      'LEGACY (non-witness) format payment txs, or the relayer must strip ' +
      'witness data before passing raw_tx to the finalize() unlocker.'
    );
  }

  const out = {
    txid: args.txid,
    block_height: startHeight,
    tx_position_in_block: mp.pos,
    headers: headers,
    header_count: N,
    raw_tx: rawTx,
    raw_tx_size: rawTx.length / 2,
    branch: branch.toString('hex'),
    branch_depth: mp.merkle.length,
    computed_root_LE: computedRoot.toString('hex'),
    expected_root_LE: expectedRoot.toString('hex'),
    merkle_root_matches: match,
    raw_tx_hashes_to_txid: rawTxHashesToTxid,
    warnings: warnings,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(match && rawTxHashesToTxid ? 0 : 3);
}

async function cmdValidateProof() {
  const args = parseArgs();
  if (!args.txid) { console.error('--txid required'); process.exit(2); }

  const meta = await btc.getTxMeta(args.txid);
  if (!meta.status || !meta.status.confirmed) {
    console.error(`tx ${args.txid} not confirmed`);
    process.exit(1);
  }
  const header = await btc.getHeaderHex(await btc.getBlockHashAtHeight(meta.status.block_height));
  const mp = await btc.getMerkleProof(args.txid);
  const branch = proof.buildBranch(mp.merkle, mp.pos);
  const computed = proof.computeRoot(args.txid, branch);
  const expected = proof.extractMerkleRoot(header);

  const match = computed.equals(expected);
  console.log(`txid:     ${args.txid}`);
  console.log(`block:    ${meta.status.block_height} / pos ${mp.pos} / depth ${mp.merkle.length}`);
  console.log(`computed: ${computed.toString('hex')}`);
  console.log(`expected: ${expected.toString('hex')}`);
  console.log(`result:   ${match ? 'PASS' : 'FAIL'}`);
  process.exit(match ? 0 : 1);
}

async function cmdBuildFinalizeTx() {
  const args = parseArgs();
  const required = ['spv-proof', 'redeem-hex', 'funding-txid', 'funding-vout',
                    'funding-amount', 'output-offset', 'to-address', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error('see --help or source for usage');
    process.exit(2);
  }

  // spv-proof can be either a file path or literal JSON (for piping).
  let spvProofRaw;
  if (fs.existsSync(args['spv-proof'])) {
    spvProofRaw = fs.readFileSync(args['spv-proof'], 'utf-8');
  } else {
    spvProofRaw = args['spv-proof'];
  }
  const spvProof = JSON.parse(spvProofRaw);

  const result = buildFinalizeTx({
    spvProof,
    redeemHex: args['redeem-hex'],
    fundingTxid: args['funding-txid'],
    fundingVout: Number(args['funding-vout']),
    fundingAmount: Number(args['funding-amount']),
    outputOffset: Number(args['output-offset']),
    toAddress: args['to-address'],
    feeSats: Number(args['fee-sats']),
  });

  console.log(`=== finalize() spending tx ===`);
  console.log(`MakerClaimed UTXO:  ${args['funding-txid']}:${args['funding-vout']} (${result.fundingAmount} sats)`);
  console.log(`P2SH address:       ${result.p2shAddress}`);
  console.log(`Fee:                ${result.fee} sats`);
  console.log(`Output:             ${result.outputAmount} sats to ${args['to-address']}`);
  console.log(`Tx size:            ${result.txSize} bytes`);
  console.log(`ScriptSig size:     ${result.scriptSigSize} bytes`);
  console.log(`  redeem script:    ${result.redeemScriptSize} bytes`);
  console.log(`  witness count:    ${result.witnessCount} (headers + branch + rawTx + outputOffset)`);
  console.log('');
  console.log('Raw tx hex:');
  console.log(result.txHex);
  console.log('');
  console.log(`Txid: ${result.txId}`);
}

async function cmdBuildClaimTx() {
  const args = parseArgs();
  const required = ['offer-redeem-hex', 'offer-funding-txid', 'offer-funding-vout',
                    'offer-funding-amount', 'claimed-redeem-hex', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    process.exit(2);
  }

  // Allow --claimed-redeem-hex and --offer-redeem-hex to accept either literal
  // hex or a file path containing hex.
  function readHex(v) {
    return fs.existsSync(v) ? fs.readFileSync(v, 'utf-8').trim() : v;
  }

  const result = buildClaimTx({
    offerRedeemHex: readHex(args['offer-redeem-hex']),
    offerFundingTxid: args['offer-funding-txid'],
    offerFundingVout: Number(args['offer-funding-vout']),
    offerFundingAmount: Number(args['offer-funding-amount']),
    claimedRedeemHex: readHex(args['claimed-redeem-hex']),
    feeSats: Number(args['fee-sats']),
  });

  console.log(`=== claim() tx ===`);
  console.log(`Offer P2SH:     ${result.offerP2SH}`);
  console.log(`Claimed P2SH:   ${result.claimedP2SH}`);
  console.log(`Fee:            ${result.fee}`);
  console.log(`Output amount:  ${result.outputAmount}`);
  console.log(`Tx size:        ${result.txSize} bytes`);
  console.log(`ScriptSig size: ${result.scriptSigSize} bytes`);
  console.log('');
  console.log('Raw tx hex:');
  console.log(result.txHex);
  console.log('');
  console.log(`Txid: ${result.txId}`);
}

async function cmdBroadcast() {
  const args = parseArgs();
  if (!args['tx-hex']) {
    console.error('--tx-hex required (hex string or file path)');
    process.exit(2);
  }
  const method = args.method || 'ssh';  // default ssh to VPS container
  const txHex = fs.existsSync(args['tx-hex'])
    ? fs.readFileSync(args['tx-hex'], 'utf-8').trim()
    : args['tx-hex'];

  if (method === 'ssh') {
    const host = args.host || 'ericadmin@89.117.20.219';
    const container = args.container || 'radiant-mainnet';
    const datadir = args.datadir || '/home/radiant/.radiant';
    const cmd = `ssh ${host} "sudo docker exec ${container} radiant-cli -datadir=${datadir} sendrawtransaction ${txHex}"`;
    try {
      const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      process.stdout.write(out);
    } catch (e) {
      console.error('broadcast failed:', e.stderr?.toString() || e.message);
      process.exit(1);
    }
  } else if (method === 'rpc') {
    // Plain JSON-RPC to a locally-reachable Radiant node. --rpc-url required.
    if (!args['rpc-url']) { console.error('--rpc-url required for --method rpc'); process.exit(2); }
    const body = JSON.stringify({
      jsonrpc: '1.0', id: 'gravity-relayer', method: 'sendrawtransaction', params: [txHex],
    });
    const res = await fetch(args['rpc-url'], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await res.json();
    if (json.error) {
      console.error('RPC error:', JSON.stringify(json.error));
      process.exit(1);
    }
    console.log(json.result);
  } else {
    console.error(`unknown --method ${method}; use 'ssh' or 'rpc'`);
    process.exit(2);
  }
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'fetch-spv-proof':
      await cmdFetchSpvProof();
      break;
    case 'validate-proof':
      await cmdValidateProof();
      break;
    case 'build-finalize-tx':
      await cmdBuildFinalizeTx();
      break;
    case 'build-claim-tx':
      await cmdBuildClaimTx();
      break;
    case 'broadcast':
      await cmdBroadcast();
      break;
    default:
      console.error(`unknown command: ${cmd || '(none)'}`);
      console.error('commands: fetch-spv-proof, validate-proof, build-finalize-tx, build-claim-tx, broadcast');
      process.exit(2);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
