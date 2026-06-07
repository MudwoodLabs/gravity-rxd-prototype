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
const path = require('path');
const { spawnSync } = require('child_process');
const btc = require('./btc');
const proof = require('./proof');
const { buildFinalizeTx } = require('./finalize_tx');
const { buildClaimTx } = require('./claim_tx');
const btcWallet = require('./btc_wallet');
const validators = require(path.join(__dirname, '..', '..', 'reference', 'validators'));

function parseArgs() {
  const argv = process.argv.slice(3); // skip: node cli.js <command>
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    args[k] = argv[i + 1];
  }
  return args;
}

// Parse a CLI-string int and exit with a clear error on junk. Native
// `Number(...)` silently returns NaN for 'abc', which then poisons
// downstream arithmetic (NaN < 0 is false, NaN + x is NaN, etc.) and
// yields opaque errors at the end of the pipeline. Use this at every
// int-coercion boundary.
function requireInt(val, name, opts = {}) {
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;
  if (val === undefined || val === null || val === '') {
    console.error(`--${name} required`); process.exit(2);
  }
  // Stringify-display helper: `JSON.stringify(NaN)` returns `"null"` which
  // is confusing inside the "got X" context; fall back to String(val).
  const display = (v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const n = parseInt(val, 10);
  if (!Number.isInteger(n) || !Number.isSafeInteger(n) || String(n) !== String(val).trim()) {
    console.error(`--${name} must be a decimal integer (got ${display(val)})`);
    process.exit(2);
  }
  if (n < min || n > max) {
    console.error(`--${name} out of range [${min}, ${max}] (got ${n})`);
    process.exit(2);
  }
  return n;
}

// Load a WIF privkey, preferring --privkey-file over --privkey-wif.
// A file load accepts either a raw WIF (optionally with trailing newline) or
// a JSON object like {"privkey_wif": "..."} (the shape emitted by btc-keygen
// --out). --privkey-wif on argv is rejected unless --i-understand-argv-leaks
// is set, because argv is visible to ps auxww and persists in shell history.
function loadPrivkey(args) {
  if (args['privkey-file']) {
    // Open-then-fstat avoids the symlink TOCTOU where an attacker could
    // swap the path between statSync and readFileSync. We open once, check
    // the file descriptor's actual inode perms, then read from the same fd.
    const bypass = args['i-understand-weak-file-perms'] === 'true' ||
                   args['i-understand-weak-file-perms'] === true;
    const fd = fs.openSync(args['privkey-file'], 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) {
        console.error(`privkey file ${args['privkey-file']} is not a regular file`);
        process.exit(2);
      }
      const weakPerms = (st.mode & 0o077) !== 0;
      const wrongOwner = typeof process.getuid === 'function' && st.uid !== process.getuid();
      const setuidBits = (st.mode & 0o6000) !== 0;  // setuid/setgid
      if (setuidBits && !bypass) {
        console.error(
          `privkey file ${args['privkey-file']} has setuid/setgid bits set ` +
          `(mode=${(st.mode & 0o7777).toString(8)}). Refusing.`
        );
        process.exit(2);
      }
      if ((weakPerms || wrongOwner) && !bypass) {
        console.error(
          `privkey file ${args['privkey-file']} has unsafe permissions ` +
          `(mode=${(st.mode & 0o777).toString(8)}, owner uid=${st.uid}). ` +
          `Expected mode 0600 owned by current uid. ` +
          `Fix with: chmod 600 ${args['privkey-file']}`
        );
        process.exit(2);
      }
      // Read from the same fd — no path-based reopen means no TOCTOU window.
      const chunks = [];
      const buf = Buffer.alloc(4096);
      let bytesRead;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        chunks.push(buf.slice(0, bytesRead).toString('utf-8'));
      }
      const raw = chunks.join('').trim();
      if (!raw) {
        console.error(`privkey file ${args['privkey-file']} is empty`);
        process.exit(2);
      }
      if (raw.startsWith('{')) {
        const obj = JSON.parse(raw);
        if (!obj.privkey_wif) {
          console.error('privkey file JSON has no privkey_wif field'); process.exit(2);
        }
        return obj.privkey_wif;
      }
      return raw;
    } finally {
      fs.closeSync(fd);
    }
  }
  if (args['privkey-wif']) {
    if (args['i-understand-argv-leaks'] !== 'true' && args['i-understand-argv-leaks'] !== true) {
      console.error(
        '--privkey-wif exposes the WIF on argv (visible to ps, shell history). ' +
        'Use --privkey-file <path> instead, or pass --i-understand-argv-leaks true ' +
        'to proceed.'
      );
      process.exit(2);
    }
    return args['privkey-wif'];
  }
  console.error('one of --privkey-file <path> or --privkey-wif <wif> required'); process.exit(2);
}

async function cmdFetchSpvProof() {
  const args = parseArgs();
  if (!args.txid) {
    console.error('--txid required');
    process.exit(2);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(args.txid)) {
    console.error('--txid must be 64 hex chars'); process.exit(2);
  }
  const N = requireInt(args.headers || '6', 'headers', { min: 1, max: 200 });

  const meta = await btc.getTxMeta(args.txid);
  if (!meta.status || !meta.status.confirmed) {
    console.error(`tx ${args.txid} not yet confirmed`);
    process.exit(1);
  }
  const txBlockHeight = meta.status.block_height;

  // Minimum-confirmation gate (audit 05 F-14). Default 6 matches Bitcoin
  // exchange deposit convention and the paper's recommended minimum.
  // Explicit --min-confirmations 0 disables for testing.
  const minConf = args['min-confirmations'] !== undefined
    ? requireInt(args['min-confirmations'], 'min-confirmations', { max: 200 })
    : 6;
  if (minConf > 0) {
    const tip = await btc.getTipHeight();
    const confs = tip - txBlockHeight + 1;
    if (confs < minConf) {
      console.error(
        `tx has ${confs} confirmations; need >= ${minConf}. ` +
        `Wait or pass --min-confirmations <lower>.`
      );
      process.exit(1);
    }
  }

  // Anchor alignment (audit 05 F-3): the covenant requires
  // h1.prevHash == btcChainAnchor, so h1 must be block anchor+1. If the
  // caller supplies --anchor-height H, we start the header chain at H+1
  // (not at the tx's block). The tx itself must land somewhere in
  // [H+1, H+N] — otherwise the flexible-Merkle-anchor check won't match
  // any header.
  let startHeight;
  if (args['anchor-height'] !== undefined) {
    const anchorHeight = requireInt(args['anchor-height'], 'anchor-height', { min: 0 });
    startHeight = anchorHeight + 1;
    if (txBlockHeight < startHeight || txBlockHeight > startHeight + N - 1) {
      console.error(
        `tx is in block ${txBlockHeight}, outside anchor window ` +
        `[${startHeight}, ${startHeight + N - 1}]. Wait for tx to confirm ` +
        `within the window, or re-anchor at a later height.`
      );
      process.exit(1);
    }
  } else {
    // No anchor supplied — fall back to legacy behaviour (h1 = tx's block).
    // This will NOT satisfy a covenant that enforces anchor alignment. Emit a
    // warning so the caller sees the mismatch before broadcasting.
    startHeight = txBlockHeight;
  }

  // Confirmation-count guard (audit 05 F-14): the returned headers must all
  // exist. Reject if the chain doesn't have N blocks on top of startHeight.
  const headers = await btc.getHeaderChain(startHeight, N);
  if (headers.length !== N) {
    console.error(`could only fetch ${headers.length}/${N} headers — tx may not be deep enough`);
    process.exit(1);
  }

  const rawTxOriginal = await btc.getRawTx(args.txid);
  const mp = await btc.getMerkleProof(args.txid);
  const branch = proof.buildBranch(mp.merkle, mp.pos);

  // Merkle branch depth check: the covenant unrolls a FIXED M levels. If
  // the block's tree is shallower than M (low-tx-count block), the covenant
  // will split past the end of the branch and fail with an opaque error.
  // Accept --merkle-depth M to reject mismatches up-front.
  if (args['merkle-depth'] !== undefined) {
    const expectedDepth = requireInt(args['merkle-depth'], 'merkle-depth', { min: 1, max: 20 });
    if (mp.merkle.length !== expectedDepth) {
      console.error(
        `merkle branch depth mismatch: mempool returned ${mp.merkle.length} ` +
        `siblings, covenant expects ${expectedDepth}. The block's tree depth ` +
        `differs from the covenant's hardcoded M. Pick a different tx (in a ` +
        `larger block) or regenerate the covenant with matching M.`
      );
      process.exit(1);
    }
  }

  // Auto-strip witness from segwit/taproot txs so that hash256(rawTx) == txid
  // and the covenant accepts the proof. User can opt out with --no-strip to
  // see what the original serialization would look like.
  const doStrip = args['no-strip'] !== 'true' && args['no-strip'] !== true;
  let rawTx = rawTxOriginal;
  let witnessStripInfo = null;
  if (doStrip) {
    const stripped = btcWallet.stripWitness(rawTxOriginal);
    rawTx = stripped.nonWitnessHex;
    witnessStripInfo = {
      was_segwit: stripped.wasSegwit,
      stripped_to_size: rawTx.length / 2,
      original_size: rawTxOriginal.length / 2,
    };
  }

  // Cross-check off-chain via the branch. The covenant's flexible Merkle
  // anchor accepts the computed root matching ANY of the N headers'
  // merkleRoot fields — the tx could legitimately have landed in h1..hN.
  // Mirror that by trying each header until one matches.
  const computedRoot = proof.computeRoot(args.txid, branch);
  const perHeaderRoots = headers.map((h, i) => ({
    index: i,
    expected: proof.extractMerkleRoot(h),
  }));
  const matchingHeader = perHeaderRoots.find(r => computedRoot.equals(r.expected));
  const match = Boolean(matchingHeader);
  const expectedRoot = matchingHeader ? matchingHeader.expected : perHeaderRoots[0].expected;

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
    // After auto-stripping, this should basically never fire. If it does,
    // it means stripWitness produced something unexpected.
    warnings.push(
      'raw_tx still does NOT hash256 to txid AFTER witness-stripping pass. ' +
      'This is unusual — the tx may be malformed or use a non-standard ' +
      'serialization. Inspect manually.'
    );
  }
  if (witnessStripInfo && witnessStripInfo.was_segwit) {
    warnings.push(
      `segwit/taproot tx was automatically stripped from ` +
      `${witnessStripInfo.original_size} → ${witnessStripInfo.stripped_to_size} bytes. ` +
      `Use --no-strip true to see the original serialization.`
    );
  }
  if (rawTx.length / 2 <= 64) {
    warnings.push(
      'raw_tx is ≤ 64 bytes — a 64-byte tx is indistinguishable from a pair ' +
      'of concatenated 32-byte Merkle nodes (CVE-class ambiguity). The ' +
      'covenant should reject this, and if not, an attacker could forge ' +
      'inclusion proofs.'
    );
  }

  // Pre-submit reference-validator pass (audit 05 F-1). We run the same
  // algorithm the covenant runs, so the relayer catches broken proofs before
  // they waste Radiant fees. Each failure becomes a warning; the exit code
  // reflects every invariant the covenant will check.
  const validation = {};
  const chainResult = validators.verifyChain(headers);
  validation.chain_pow_and_link = chainResult.allOk;
  if (!chainResult.allOk) {
    warnings.push(
      'chain validation FAILED: ' + chainResult.results.filter(r => !r.powOk || !r.linkOk)
        .map(r => `[${r.index}] ${r.reason}`).join('; ')
    );
  }
  if (args['anchor-hash']) {
    if (!/^[0-9a-fA-F]{64}$/.test(args['anchor-hash'])) {
      console.error('--anchor-hash must be 64 hex chars'); process.exit(2);
    }
    const anchor = validators.verifyAnchor(headers[0], args['anchor-hash']);
    validation.chain_anchor = anchor.pass;
    if (!anchor.pass) {
      warnings.push(
        `anchor mismatch: h1.prevHash is ${anchor.got}, expected ${args['anchor-hash']}. ` +
        `The covenant will reject — pass the right --anchor-hash or re-anchor.`
      );
    }
  }

  // expectedNBits check (covenant's CV-1 defense). Accepts either
  // --expected-nbits alone or both --expected-nbits + --expected-nbits-next
  // (the latter covers Bitcoin retarget boundaries).
  if (args['expected-nbits']) {
    if (!/^[0-9a-fA-F]{8}$/.test(args['expected-nbits'])) {
      console.error('--expected-nbits must be 8 hex chars (4 bytes LE)'); process.exit(2);
    }
    const nbNext = args['expected-nbits-next'];
    if (nbNext && !/^[0-9a-fA-F]{8}$/.test(nbNext)) {
      console.error('--expected-nbits-next must be 8 hex chars (4 bytes LE)'); process.exit(2);
    }
    const nb = validators.verifyNBitsMatch(headers, args['expected-nbits'], nbNext);
    validation.nbits_match = nb.pass;
    if (!nb.pass) {
      warnings.push(`expectedNBits mismatch: ${nb.reason}`);
    }
  }

  // Structural tx-layout check (covenant's CV-2 defense).
  const structResult = validators.verifyTxStructure(rawTx);
  validation.tx_structure = structResult.pass;
  if (!structResult.pass) {
    warnings.push(
      `tx structure invalid: ${structResult.reason}. Covenant requires a ` +
      `single-input segwit tx with Maker payment as output[0].`
    );
  }

  // Payment identity check (covenant's payment branch).
  if (args['btc-receive-hash'] && args['btc-satoshis'] && args['btc-receive-type']) {
    if (!/^[0-9a-fA-F]+$/.test(args['btc-receive-hash'])) {
      console.error('--btc-receive-hash must be hex'); process.exit(2);
    }
    const sats = requireInt(args['btc-satoshis'], 'btc-satoshis', { min: 0 });
    const type = args['btc-receive-type'];
    if (!validators.PAYMENT_TYPES[type]) {
      console.error(`--btc-receive-type must be one of: ${Object.keys(validators.PAYMENT_TYPES).join('|')}`); process.exit(2);
    }
    // outputOffset comes from the structural check (47 for native segwit,
    // 70 for P2SH-P2WPKH Taker input). Payment check is skipped silently
    // if the structural check failed (we already warned).
    if (structResult.pass) {
      const pay = validators.verifyPayment(
        rawTx, structResult.outputOffset,
        args['btc-receive-hash'], sats, type,
      );
      validation.payment = pay.pass;
      if (!pay.pass) {
        warnings.push(`payment check FAILED: ${pay.reason}`);
      }
    }
  }

  const out = {
    txid: args.txid,
    tx_block_height: txBlockHeight,
    h1_block_height: startHeight,
    tx_position_in_block: mp.pos,
    anchor_height: args['anchor-height'] !== undefined ? parseInt(args['anchor-height'], 10) : null,
    anchor_hash: args['anchor-hash'] || null,
    headers: headers,
    header_count: N,
    raw_tx: rawTx,
    raw_tx_size: rawTx.length / 2,
    branch: branch.toString('hex'),
    branch_depth: mp.merkle.length,
    computed_root_LE: computedRoot.toString('hex'),
    expected_root_LE: expectedRoot.toString('hex'),
    merkle_root_matches: match,
    merkle_root_matching_header: matchingHeader ? matchingHeader.index : null,
    raw_tx_hashes_to_txid: rawTxHashesToTxid,
    validation,
    warnings: warnings,
  };

  console.log(JSON.stringify(out, null, 2));
  // Exit non-zero if any invariant the covenant will check has failed. Checks
  // that are always run (core): Merkle root match, hash256(rawTx)==txid,
  // chain PoW+link, tx structural layout. Checks run conditionally on CLI
  // flags (anchor, nbits, payment): only count against the exit code if the
  // flag was provided.
  const ok =
    match &&
    rawTxHashesToTxid &&
    validation.chain_pow_and_link &&
    validation.tx_structure &&
    (validation.chain_anchor === undefined || validation.chain_anchor === true) &&
    (validation.nbits_match === undefined || validation.nbits_match === true) &&
    (validation.payment === undefined || validation.payment === true);
  process.exit(ok ? 0 : 3);
}

async function cmdValidateProof() {
  const args = parseArgs();
  if (!args.txid) { console.error('--txid required'); process.exit(2); }
  if (!/^[0-9a-fA-F]{64}$/.test(args.txid)) {
    console.error('--txid must be exactly 64 hex chars'); process.exit(2);
  }

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
                    'funding-amount', 'to-address', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error('see --help or source for usage');
    process.exit(2);
  }

  // spv-proof can be either a file path or literal JSON (for piping).
  let spvProofRaw;
  const spvProofResolved = path.resolve(args['spv-proof']);
  if (fs.existsSync(spvProofResolved)) {
    spvProofRaw = fs.readFileSync(spvProofResolved, 'utf-8');
  } else {
    spvProofRaw = args['spv-proof'];
  }
  const spvProof = JSON.parse(spvProofRaw);

  // redeem-hex may be a file path OR literal hex (mirrors build-claim-tx).
  // If we treat a path as hex, `Buffer.from(path, 'hex')` silently drops
  // non-hex chars, producing a tiny garbage buffer and a broken finalize tx.
  const redeemHexResolved = path.resolve(args['redeem-hex']);
  const redeemHex = fs.existsSync(redeemHexResolved)
    ? fs.readFileSync(redeemHexResolved, 'utf-8').trim()
    : args['redeem-hex'];

  const result = buildFinalizeTx({
    spvProof,
    redeemHex,
    fundingTxid: args['funding-txid'],
    fundingVout: requireInt(args['funding-vout'], 'funding-vout', { max: 0xffffffff }),
    fundingAmount: requireInt(args['funding-amount'], 'funding-amount', { min: 1 }),
    toAddress: args['to-address'],
    feeSats: requireInt(args['fee-sats'], 'fee-sats', { min: 0 }),
    // Optional independent re-checks (see finalize_tx.js): if provided, the
    // builder refuses to emit a tx that doesn't satisfy the covenant's
    // payment / nBits / anchor requirements.
    expectedNBits: args['expected-nbits'],
    expectedNBitsNext: args['expected-nbits-next'],
    anchorHash: args['anchor-hash'],
    btcReceiveHash: args['btc-receive-hash'],
    btcReceiveType: args['btc-receive-type'],
    btcSatoshis: args['btc-satoshis'] !== undefined
      ? requireInt(args['btc-satoshis'], 'btc-satoshis', { min: 0 })
      : undefined,
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

  // MakerOffer.claim() now requires a Taker signature — pass the WIF via
  // --privkey-file (preferred) or --privkey-wif (opt-in, argv-leaky).
  const takerPrivkeyWif = loadPrivkey(args);

  // Allow --claimed-redeem-hex and --offer-redeem-hex to accept either literal
  // hex or a file path containing hex.
  function readHex(v) {
    const resolved = path.resolve(v);
    return fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf-8').trim() : v;
  }

  const result = buildClaimTx({
    offerRedeemHex: readHex(args['offer-redeem-hex']),
    offerFundingTxid: args['offer-funding-txid'],
    offerFundingVout: requireInt(args['offer-funding-vout'], 'offer-funding-vout', { max: 0xffffffff }),
    offerFundingAmount: requireInt(args['offer-funding-amount'], 'offer-funding-amount', { min: 1 }),
    claimedRedeemHex: readHex(args['claimed-redeem-hex']),
    feeSats: requireInt(args['fee-sats'], 'fee-sats', { min: 0 }),
    takerPrivkeyWif,
    // Optional: if provided, the builder will re-hash the claimed redeem
    // script and assert it matches the 32-byte expected code hash before
    // broadcasting. Prevents wasted fees on a claim the MakerOffer will
    // reject on-chain.
    expectedClaimedCodeHash: args['expected-claimed-code-hash'],
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
  const txHexResolved = path.resolve(args['tx-hex']);
  const txHex = fs.existsSync(txHexResolved)
    ? fs.readFileSync(txHexResolved, 'utf-8').trim()
    : args['tx-hex'];

  if (method === 'ssh') {
    const host = args.host;
    const container = args.container || 'radiant-mainnet';
    const datadir = args.datadir || '/home/radiant/.radiant';

    // All four inputs go through ssh to a remote shell. Validate strictly
    // to prevent injection on either side. txHex is the largest surface and
    // the only one that regularly carries large attacker-controlled content
    // (via --tx-hex <path>), so its regex is pinned to hex-only.
    if (!host || host.startsWith('<')) {
      console.error('--host required (e.g. user@radiant-node)');
      process.exit(2);
    }
    if (!/^[A-Za-z0-9._@-]+$/.test(host)) {
      console.error('--host contains unsupported characters'); process.exit(2);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(container)) {
      console.error('--container contains unsupported characters'); process.exit(2);
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(datadir)) {
      console.error('--datadir contains unsupported characters'); process.exit(2);
    }
    if (!/^[0-9a-fA-F]+$/.test(txHex) || txHex.length % 2 !== 0) {
      console.error('tx hex must be even-length hex string'); process.exit(2);
    }

    const remoteCmd =
      `sudo docker exec ${container} radiant-cli -datadir=${datadir} ` +
      `sendrawtransaction ${txHex}`;
    const r = spawnSync('ssh', [host, remoteCmd], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      // Strip the tx hex from any stderr echo so CI logs don't capture it.
      const redacted = (r.stderr || '').replace(txHex, '<tx-hex-redacted>');
      console.error('broadcast failed:', redacted || r.error?.message || 'unknown');
      process.exit(1);
    }
    process.stdout.write(r.stdout);
  } else if (method === 'rpc') {
    // Plain JSON-RPC to a locally-reachable Radiant node. --rpc-url required.
    if (!args['rpc-url']) { console.error('--rpc-url required for --method rpc'); process.exit(2); }
    const rpcUrl = args['rpc-url'];
    // Guard against typo/exfil: must be http:// or https://. Accept http://
    // only when the operator passes --allow-plaintext-rpc true (many Radiant
    // nodes only listen on plain HTTP inside a trusted network).
    if (!/^https?:\/\//.test(rpcUrl)) {
      console.error(`--rpc-url must begin with http:// or https:// (got ${rpcUrl})`);
      process.exit(2);
    }
    if (rpcUrl.startsWith('http://') &&
        args['allow-plaintext-rpc'] !== 'true' && args['allow-plaintext-rpc'] !== true) {
      console.error(
        `--rpc-url is plain http:// and credentials/tx-hex would be sent in ` +
        `the clear. Add --allow-plaintext-rpc true to confirm or use https://.`
      );
      process.exit(2);
    }
    // Also validate txHex as hex here (ssh path already does this; keep
    // rpc path symmetric so malformed rawtx doesn't pollute the RPC node).
    if (!/^[0-9a-fA-F]+$/.test(txHex) || txHex.length % 2 !== 0) {
      console.error('tx hex must be even-length hex string'); process.exit(2);
    }
    const body = JSON.stringify({
      jsonrpc: '1.0', id: 'gravity-relayer', method: 'sendrawtransaction', params: [txHex],
    });
    const res = await fetch(rpcUrl, {
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

async function cmdBtcKeygen() {
  const args = parseArgs();
  const kp = btcWallet.generateKeypair();

  const outPath = args.out;
  if (outPath) {
    // Write the full keypair (incl. WIF) to a file with 0600, print only
    // public material to stdout so the privkey never hits terminal scrollback.
    fs.writeFileSync(outPath, JSON.stringify(kp, null, 2), { mode: 0o600 });
    // Re-chmod in case umask masked the create mode.
    fs.chmodSync(outPath, 0o600);
    const { privkey_wif: _ignored, ...pub } = kp;
    console.log(JSON.stringify({ ...pub, privkey_wif_path: outPath }, null, 2));
    return;
  }
  if (args['print-privkey'] !== 'true' && args['print-privkey'] !== true) {
    console.error(
      'refusing to print WIF to stdout. Pass --out <path> to write keys to a ' +
      '0600 file (recommended), or --print-privkey true to keep the old behaviour.'
    );
    process.exit(2);
  }
  console.log(JSON.stringify(kp, null, 2));
}

async function cmdBtcGetUtxos() {
  const args = parseArgs();
  if (!args.address) { console.error('--address required'); process.exit(2); }
  const utxos = await btcWallet.getUtxos(args.address);
  console.log(JSON.stringify(utxos, null, 2));
}

async function cmdBtcBuildPayment() {
  const args = parseArgs();
  const required = ['utxo-txid', 'utxo-vout', 'utxo-amount',
                    'to-hash', 'to-type', 'amount-sats', 'fee-sats'];
  const missing = required.filter(k => !args[k]);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error(
      'Phase-3 covenant requires 1-input segwit (P2WPKH) Taker tx. ' +
      'The Taker UTXO MUST be a P2WPKH output; --to-type chooses the ' +
      'Maker destination format (p2pkh|p2wpkh|p2sh|p2tr). --to-hash is ' +
      'the 20- or 32-byte hash the Maker committed as btcReceiveHash.'
    );
    process.exit(2);
  }

  // Privkey source: prefer --privkey-file (private, not on argv / in shell
  // history). --privkey-wif on argv is visible to ps auxww and shell history,
  // so only accept it when the user opts in explicitly.
  const privkeyWif = loadPrivkey(args);

  // Covenant allows exactly 1 input — do not accept multi-UTXO bundles.
  if (args.utxos) {
    console.error(
      '--utxos is deprecated. Covenant requires a single P2WPKH input. ' +
      'Consolidate your UTXOs into one P2WPKH output first, then use ' +
      '--utxo-txid/--utxo-vout/--utxo-amount for that single UTXO.'
    );
    process.exit(2);
  }
  const inputs = [{
    txid: args['utxo-txid'],
    vout: requireInt(args['utxo-vout'], 'utxo-vout', { max: 0xffffffff }),
    value: requireInt(args['utxo-amount'], 'utxo-amount', { min: 1 }),
  }];

  // Cross-check the UTXO's actual scriptPubKey type against the user's
  // claimed --input-type. A mismatch signs successfully but fails at
  // consensus, wasting time. Skip with --skip-utxo-typecheck true for
  // offline / testing workflows.
  if (args['skip-utxo-typecheck'] !== 'true' && args['skip-utxo-typecheck'] !== true) {
    const wanted = args['input-type'] || 'p2wpkh';
    const actual = await btc.getUtxoScriptType(inputs[0].txid, inputs[0].vout);
    const expectedFor = { 'p2wpkh': ['v0_p2wpkh'], 'p2sh-p2wpkh': ['p2sh'] };
    const accepted = expectedFor[wanted] || [];
    if (!accepted.includes(actual)) {
      console.error(
        `UTXO ${inputs[0].txid}:${inputs[0].vout} has scriptPubKey type ` +
        `'${actual}', but --input-type=${wanted} expects one of ` +
        `${accepted.join(' or ')}. Either use a matching UTXO or pass ` +
        `--skip-utxo-typecheck true if you know what you're doing.`
      );
      process.exit(2);
    }
  }

  const result = btcWallet.buildSignedPaymentTx({
    privkeyWif,
    inputs,
    toType: args['to-type'],
    toHashHex: args['to-hash'],
    amountSats: requireInt(args['amount-sats'], 'amount-sats', { min: 1 }),
    feeSats: requireInt(args['fee-sats'], 'fee-sats', { min: 0 }),
    changeAddress: args['change-address'],
    // Shape of the Taker's funding UTXO. 'p2wpkh' (default, bc1q…) or
    // 'p2sh-p2wpkh' (3… wrapped segwit). Covenant accepts both post-Phase-5.
    inputType: args['input-type'] || 'p2wpkh',
  });

  console.log('=== BTC payment tx (segwit-v0, single P2WPKH input) ===');
  console.log(`Input type:   ${result.inputType}`);
  console.log(`Sender addr:  ${result.senderAddress}`);
  console.log(`Output type:  ${result.outputType}`);
  console.log(`To hash:      ${args['to-hash']}`);
  console.log(`Amount:       ${args['amount-sats']} sats`);
  console.log(`Fee:          ${result.fee} sats`);
  console.log(`Change:       ${result.change} sats`);
  if (result.feeSwept) console.log(`(Dust ${result.feeSwept} sats swept to fee — below 546 dust threshold)`);
  console.log(`Tx size:      ${result.size} bytes (includes witness)`);
  console.log(`Outputs:      ${result.outputCount}`);
  console.log('');
  console.log('Raw tx hex (broadcast this — includes witness):');
  console.log(result.txHex);
  console.log('');
  console.log(`Txid (BE): ${result.txId}`);
}

async function cmdBtcBroadcast() {
  const args = parseArgs();
  if (!args['tx-hex']) { console.error('--tx-hex required'); process.exit(2); }
  const btcTxHexResolved = path.resolve(args['tx-hex']);
  const txHex = fs.existsSync(btcTxHexResolved)
    ? fs.readFileSync(btcTxHexResolved, 'utf-8').trim()
    : args['tx-hex'];
  const txid = await btcWallet.broadcastTx(txHex);
  console.log(txid);
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
    case 'btc-keygen':
      await cmdBtcKeygen();
      break;
    case 'btc-get-utxos':
      await cmdBtcGetUtxos();
      break;
    case 'btc-build-payment':
      await cmdBtcBuildPayment();
      break;
    case 'btc-broadcast':
      await cmdBtcBroadcast();
      break;
    default:
      console.error(`unknown command: ${cmd || '(none)'}`);
      console.error('Radiant:  fetch-spv-proof, validate-proof, build-finalize-tx, build-claim-tx, broadcast');
      console.error('Bitcoin:  btc-keygen, btc-get-utxos, btc-build-payment, btc-broadcast');
      process.exit(2);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
