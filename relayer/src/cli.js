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

const btc = require('./btc');
const proof = require('./proof');

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

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'fetch-spv-proof':
      await cmdFetchSpvProof();
      break;
    case 'validate-proof':
      await cmdValidateProof();
      break;
    default:
      console.error(`unknown command: ${cmd || '(none)'}`);
      console.error('commands: fetch-spv-proof, validate-proof');
      process.exit(2);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
