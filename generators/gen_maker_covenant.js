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
if (!(N >= 1 && N <= 144) || !(M >= 1 && M <= 20)) {
  console.error(`usage: gen_maker_covenant.js <headers 1-144> <merkleDepth 1-20> [--flat]`);
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

// Payment verification.
function paymentBlock() {
  return [
    `// --- BTC payment verification ---`,
    `bytes output = rawTx.split(outputOffset)[1].split(34)[0];`,
    `int value = int(output.split(8)[0]);`,
    `require(value >= btcSatoshis);`,
    `bytes scriptSection = output.split(8)[1];`,
    `bytes prefix = scriptSection.split(4)[0];`,
    `require(prefix == 0x1976a914);`,
    `bytes pkh = scriptSection.split(4)[1].split(20)[0];`,
    `require(pkh == btcReceivePkh);`,
    `bytes suffix = scriptSection.split(24)[1];`,
    `require(suffix == 0x88ac);`,
  ];
}

const lines = [];
lines.push(`pragma radiantscript ^0.1.0;`);
lines.push(``);
lines.push(`// Gravity Maker covenant — State 2 (Claimed) with full SPV integration`);
lines.push(`// Auto-generated: N=${N} headers, M=${M} Merkle depth`);
lines.push(`// Do not edit by hand; regenerate with gen_maker_covenant.js.`);
lines.push(``);
if (flat) {
  // Flat layout: all params as constructor args. Used for direct-fund
  // scenarios where the entire covenant instance (state + code) is fully
  // determined at deploy time, with no MakerOffer binding flow.
  lines.push(`contract MakerCovenantFlat${N}x${M}(`);
  lines.push(`    bytes20 makerPkh,`);
  lines.push(`    bytes20 takerRadiantPkh,`);
  lines.push(`    bytes20 btcReceivePkh,`);
  lines.push(`    int btcSatoshis,`);
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
  lines.push(`contract MakerCovenant${N}x${M}(`);
  lines.push(`    bytes20 makerPkh,`);
  lines.push(`    bytes20 btcReceivePkh,`);
  lines.push(`    int btcSatoshis,`);
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
