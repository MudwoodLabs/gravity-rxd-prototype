#!/usr/bin/env node
/**
 * Generator: emit a RadiantScript contract that is the full Maker-side
 * Gravity covenant, State-2 (post-claim). Integrates:
 *   - N-header chain PoW verification
 *   - M-level Merkle branch verification
 *   - Bitcoin P2PKH payment verification
 *   - Radiant spending paths (finalize routes to Taker, forfeit to Maker)
 *
 * Does NOT include State-1 claim logic — see maker_offer.rxd for that
 * skeleton. Cross-contract binding (MakerOffer.claim → MakerClaimed)
 * is still a TODO.
 *
 * Usage: node gen_maker_covenant.js <headers> <merkleDepth> > contracts/maker_covenant_NxM.rxd
 */

const N = parseInt(process.argv[2] || '2', 10);
const M = parseInt(process.argv[3] || '4', 10);
const flat = process.argv.includes('--flat');

// Optional: restrict to a single BTC output type for a smaller script.
//   --btc-type p2pkh | p2wpkh | p2sh | p2tr | all   (default: all)
let btcTypeArg = 'all';
{
  const idx = process.argv.indexOf('--btc-type');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    btcTypeArg = process.argv[idx + 1].toLowerCase();
  }
}
const VALID_TYPES = ['all', 'p2pkh', 'p2wpkh', 'p2sh', 'p2tr'];
if (!VALID_TYPES.includes(btcTypeArg)) {
  console.error(`--btc-type must be one of: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

if (!(N >= 1 && N <= 144) || !(M >= 1 && M <= 20)) {
  console.error(`usage: gen_maker_covenant.js <headers 1-144> <merkleDepth 1-20> [--flat] [--btc-type p2pkh|p2wpkh|p2sh|p2tr|all]`);
  process.exit(1);
}

function indent(lines, spaces = 12) {
  const pad = ' '.repeat(spaces);
  return lines.map(l => (l.length ? pad + l : l)).join('\n');
}

// PoW verification for header slot i.  Produces bool `pow{i}` and bytes32 `hash{i}`.
function powBlock(i) {
  const H = `h${i}`;
  return [
    `// --- PoW check: ${H} ---`,
    `bytes n${i} = ${H}.split(72)[1].split(4)[0];`,
    `bytes m${i} = n${i}.split(3)[0];`,
    `int e${i} = int(n${i}.split(3)[1]);`,
    `bytes t${i} = bytes(0, e${i} - 3) + m${i} + bytes(0, 32 - e${i});`,
    ``,
    `bytes32 hash${i} = hash256(${H});`,
    `bytes hBE${i} = hash${i}.reverse();`,
    `bytes tBE${i} = t${i}.reverse();`,
    ``,
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => {
      const src = k === 0 ? `hBE${i}.split(4)[0]` :
                  k === 7 ? `hBE${i}.split(28)[1]` :
                            `hBE${i}.split(${k * 4})[1].split(4)[0]`;
      return `int h${i}c${k} = int(${src}.reverse());`;
    }),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => {
      const src = k === 0 ? `tBE${i}.split(4)[0]` :
                  k === 7 ? `tBE${i}.split(28)[1]` :
                            `tBE${i}.split(${k * 4})[1].split(4)[0]`;
      return `int t${i}c${k} = int(${src}.reverse());`;
    }),
    ``,
    `bool pow${i} =`,
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((k, idx) => {
      const eqPart = [...Array(k).keys()].map(j => `(h${i}c${j} == t${i}c${j})`).join(' && ');
      const ltPart = `(h${i}c${k} < t${i}c${k})`;
      const expr = k === 0 ? ltPart : `(${eqPart} && ${ltPart})`;
      const sep = idx === 7 ? ';' : ' ||';
      return `    ${expr}${sep}`;
    }),
    `require(pow${i});`,
  ];
}

// Merkle branch verification — iterates over `current`.
function merkleBlock(M) {
  const lines = [
    `// --- Merkle branch verification (depth ${M}) ---`,
    `// Anchor: hash of rawTx must chain up to h1's merkleRoot via branch.`,
    `bytes32 current = hash256(rawTx);`,
  ];
  for (let i = 0; i < M; i++) {
    const offsetExpr = i === 0 ? 'branch' : `branch.split(${i * 33})[1]`;
    lines.push(...[
      `// level ${i}`,
      `bytes lvl${i} = ${offsetExpr}.split(33)[0];`,
      `bytes dir${i} = lvl${i}.split(1)[0];`,
      `bytes sib${i} = lvl${i}.split(1)[1];`,
      `if (dir${i} == 0x00) {`,
      `    current = hash256(current + sib${i});`,
      `} else {`,
      `    current = hash256(sib${i} + current);`,
      `}`,
    ]);
  }
  // h1.merkleRoot is bytes[36..68] of the header.
  lines.push(
    `// Chain up to h1.merkleRoot`,
    `bytes expectedRoot = h1.split(36)[1].split(32)[0];`,
    `require(current == expectedRoot);`,
  );
  return lines;
}

// Payment verification — branches on btcReceiveType param:
//   0 = P2PKH   output is 34 B (8 value + 0x19 + 76a914 + 20B hash + 88ac)
//   1 = P2WPKH  output is 31 B (8 value + 0x16 + 0014 + 20B hash)
//   2 = P2SH    output is 32 B (8 value + 0x17 + a914 + 20B hash + 87)
//   3 = P2TR    output is 43 B (8 value + 0x22 + 5120 + 32B x-only pubkey)
// btcReceiveHash holds the 20- or 32-byte pubkey/script-hash.
//
// When --btc-type is one of p2pkh/p2wpkh/p2sh/p2tr, only that single branch
// is emitted (no btcReceiveType param, smaller script).

function paymentBlockP2PKH() {
  return [
    `// P2PKH: 34-byte output`,
    `bytes output = rawTx.split(outputOffset)[1].split(34)[0];`,
    `int value = int(output.split(8)[0]);`,
    `require(value >= btcSatoshis);`,
    `bytes scriptSection = output.split(8)[1];`,
    `bytes prefix = scriptSection.split(4)[0];`,
    `require(prefix == 0x1976a914);`,
    `bytes hash = scriptSection.split(4)[1].split(20)[0];`,
    `require(hash == btcReceiveHash);`,
    `bytes suffix = scriptSection.split(24)[1];`,
    `require(suffix == 0x88ac);`,
  ];
}
function paymentBlockP2WPKH() {
  return [
    `// P2WPKH: 31-byte output`,
    `bytes output = rawTx.split(outputOffset)[1].split(31)[0];`,
    `int value = int(output.split(8)[0]);`,
    `require(value >= btcSatoshis);`,
    `bytes scriptSection = output.split(8)[1];`,
    `bytes prefix = scriptSection.split(3)[0];`,
    `require(prefix == 0x160014);`,
    `bytes hash = scriptSection.split(3)[1];`,
    `require(hash == btcReceiveHash);`,
  ];
}
function paymentBlockP2SH() {
  return [
    `// P2SH: 32-byte output`,
    `bytes output = rawTx.split(outputOffset)[1].split(32)[0];`,
    `int value = int(output.split(8)[0]);`,
    `require(value >= btcSatoshis);`,
    `bytes scriptSection = output.split(8)[1];`,
    `bytes prefix = scriptSection.split(3)[0];`,
    `require(prefix == 0x17a914);`,
    `bytes hash = scriptSection.split(3)[1].split(20)[0];`,
    `require(hash == btcReceiveHash);`,
    `bytes suffix = scriptSection.split(23)[1];`,
    `require(suffix == 0x87);`,
  ];
}
function paymentBlockP2TR() {
  return [
    `// P2TR: 43-byte output`,
    `bytes output = rawTx.split(outputOffset)[1].split(43)[0];`,
    `int value = int(output.split(8)[0]);`,
    `require(value >= btcSatoshis);`,
    `bytes scriptSection = output.split(8)[1];`,
    `bytes prefix = scriptSection.split(3)[0];`,
    `require(prefix == 0x225120);`,
    `bytes hash = scriptSection.split(3)[1];`,
    `require(hash == btcReceiveHash);`,
  ];
}

function paymentBlock() {
  if (btcTypeArg === 'p2pkh')  return [`// --- BTC payment verification (P2PKH) ---`, ...paymentBlockP2PKH()];
  if (btcTypeArg === 'p2wpkh') return [`// --- BTC payment verification (P2WPKH) ---`, ...paymentBlockP2WPKH()];
  if (btcTypeArg === 'p2sh')   return [`// --- BTC payment verification (P2SH) ---`, ...paymentBlockP2SH()];
  if (btcTypeArg === 'p2tr')   return [`// --- BTC payment verification (P2TR) ---`, ...paymentBlockP2TR()];

  // all: 4-way branch
  const indent4 = (l) => '    ' + l;
  return [
    `// --- BTC payment verification (branches on btcReceiveType) ---`,
    `if (btcReceiveType == 0) {`,
    ...paymentBlockP2PKH().map(indent4),
    `} else {`,
    `    if (btcReceiveType == 1) {`,
    ...paymentBlockP2WPKH().map(l => '        ' + l),
    `    } else {`,
    `        if (btcReceiveType == 2) {`,
    ...paymentBlockP2SH().map(l => '            ' + l),
    `        } else {`,
    `            // Must be P2TR (type 3)`,
    `            require(btcReceiveType == 3);`,
    ...paymentBlockP2TR().map(l => '            ' + l),
    `        }`,
    `    }`,
    `}`,
  ];
}

const lines = [];
lines.push(`pragma radiantscript ^0.1.0;`);
lines.push(``);
lines.push(`// Gravity Maker covenant — State 2 (Claimed) with full SPV integration`);
lines.push(`// Auto-generated: N=${N} headers, M=${M} Merkle depth`);
lines.push(`// Do not edit by hand; regenerate with gen_maker_covenant.js.`);
lines.push(``);
// When a single btc-type is chosen, we don't need the dispatch param.
const includeTypeParam = btcTypeArg === 'all';
const nameSuffix = btcTypeArg === 'all' ? '' : '_' + btcTypeArg;

if (flat) {
  // Flat layout: all params as constructor args. Used for direct-fund
  // scenarios where the entire covenant instance (state + code) is fully
  // determined at deploy time, with no MakerOffer binding flow.
  lines.push(`contract MakerCovenantFlat${N}x${M}${nameSuffix}(`);
  lines.push(`    bytes20 makerPkh,`);
  lines.push(`    bytes20 takerRadiantPkh,`);
  lines.push(`    bytes btcReceiveHash,`);
  if (includeTypeParam) lines.push(`    int btcReceiveType,`);
  lines.push(`    int btcSatoshis,`);
  lines.push(`    bytes32 btcChainAnchor,     // hash256 of a known mainnet block; h1.prevHash must equal this`);
  lines.push(`    int claimDeadline,`);
  lines.push(`    int totalPhotonsInOutput`);
  lines.push(`) {`);
  lines.push(`    return {`);
} else {
  // State-separated layout: code-section params (hashed into the bytecode
  // Maker commits to) go in the contract() param list. State-section params
  // (set at claim time by the Taker) go in the function() param list. The
  // generated contract's code-script hash is identical regardless of Taker
  // pkh or deadline, so MakerOffer can precommit to it.
  lines.push(`contract MakerCovenant${N}x${M}${nameSuffix}(`);
  lines.push(`    bytes20 makerPkh,`);
  lines.push(`    bytes btcReceiveHash,`);
  if (includeTypeParam) lines.push(`    int btcReceiveType,`);
  lines.push(`    int btcSatoshis,`);
  lines.push(`    bytes32 btcChainAnchor,     // hash256 of a known mainnet block; h1.prevHash must equal this`);
  lines.push(`    int totalPhotonsInOutput`);
  lines.push(`) function(`);
  lines.push(`    bytes20 takerRadiantPkh,`);
  lines.push(`    int claimDeadline`);
  lines.push(`) {`);
  lines.push(`    // Grammar requires at least one statement before stateSeparator.`);
  lines.push(`    // Use trivially-true requires that reference both state params.`);
  lines.push(`    require(takerRadiantPkh.length == 20);`);
  lines.push(`    require(claimDeadline >= 0);`);
  lines.push(``);
  lines.push(`    stateSeparator;`);
  lines.push(``);
  lines.push(`    return {`);
}

// finalize function signature: accepts N headers, M×33-byte branch, rawTx, outputOffset
const headerParams = Array.from({ length: N }, (_, i) => `bytes h${i + 1}`).join(', ');
lines.push(`        finalize(${headerParams}, bytes branch, bytes rawTx, int outputOffset) {`);

// Chain-identity anchor: verify h1's prevHash matches a Maker-committed
// hash of a known mainnet block. This is the network-identity guarantee —
// without this check, an attacker could forge a cheap testnet chain whose
// PoW passes verification but whose "payment" never happened on mainnet.
lines.push(indent([
  `// --- Chain-identity anchor: h1 must extend from a known mainnet block ---`,
  `bytes h1Prev = h1.split(4)[1].split(32)[0];`,
  `require(h1Prev == btcChainAnchor);`,
  ``,
]));

// Chain of header verifications
for (let i = 1; i <= N; i++) {
  if (i > 1) {
    lines.push(indent([
      `// --- Chain link: h${i}.prevHash == hash${i - 1} ---`,
      `bytes prev${i} = h${i}.split(4)[1].split(32)[0];`,
      `require(prev${i} == hash${i - 1});`,
      ``,
    ]));
  }
  lines.push(indent(powBlock(i)));
  lines.push('');
}

// Merkle proof
lines.push(indent(merkleBlock(M)));
lines.push('');

// Payment check
lines.push(indent(paymentBlock()));
lines.push('');

// Route output to Taker
lines.push(indent([
  `// --- Route to Taker ---`,
  `bytes25 takerLock = new LockingBytecodeP2PKH(takerRadiantPkh);`,
  `require(tx.outputs[0].lockingBytecode == takerLock);`,
  `require(tx.outputs[0].value >= totalPhotonsInOutput);`,
]));

lines.push(`        },`);
lines.push(``);

// Forfeit function
lines.push(`        forfeit() {`);
lines.push(`            require(tx.time >= claimDeadline);`);
lines.push(`            bytes25 makerLock = new LockingBytecodeP2PKH(makerPkh);`);
lines.push(`            require(tx.outputs[0].lockingBytecode == makerLock);`);
lines.push(`            require(tx.outputs[0].value >= totalPhotonsInOutput);`);
lines.push(`        }`);

lines.push(`    };`);
lines.push(`}`);

console.log(lines.join('\n'));
