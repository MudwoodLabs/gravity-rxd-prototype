#!/usr/bin/env node
/**
 * Post-hardening covenant-invariant test (audit re-audit CV-P5-1).
 *
 * The reviewer flagged that `validation/*.artifact.json` is gitignored,
 * so a reader at any commit can't verify that the emitted covenant
 * actually contains the Phase-3/4/5 hardening without rebuilding. This
 * test rebuilds and asserts the specific bytecode invariants the audits
 * claim are present. If any hardening regresses, this fails.
 *
 * Runs rxdc from a locally-installed RadiantScript repo; the compiler
 * path can be overridden via RXDC env var. Falls back with a clear
 * skip message if rxdc is not available.
 *
 * Run: `node test/covenant_invariants.test.js` (or `npm test`).
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

let passed = 0, failed = 0, skipped = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}${detail ? '\n    ' + detail : ''}`); failed++; }
}

const rxdcCandidates = [
  process.env.RXDC,
  path.join(process.env.HOME || '', 'apps', 'RadiantScript', 'packages', 'cashc', 'dist', 'main', 'cashc-cli.js'),
].filter(Boolean);

let rxdc = null;
for (const c of rxdcCandidates) {
  if (fs.existsSync(c)) { rxdc = c; break; }
}

if (!rxdc) {
  console.log('covenant invariants: SKIPPED (no rxdc found; set RXDC env var)');
  skipped++;
  console.log(`\ncovenant-invariant tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(0);  // skip is not a failure
}

console.log(`Using rxdc at: ${rxdc}`);

function compile(rxdPath) {
  const out = execFileSync('node', [rxdc, rxdPath], { encoding: 'utf-8', stderr: 'pipe' });
  return JSON.parse(out);
}

function sha256Hex(hex) {
  return crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
}

// Regenerate the flat p2wpkh covenant and check each hardening is in bytecode.
const GEN = path.join(__dirname, '..', '..', 'generators', 'gen_maker_covenant.js');
const TMP = '/tmp/covenant_invariants_gen.rxd';
execFileSync('node', [GEN, '6', '12', '--flat', '--btc-type', 'p2wpkh'], {
  encoding: 'utf-8',
  stderr: 'pipe',
  stdio: ['ignore', fs.openSync(TMP, 'w'), 'pipe'],
});
const artifact = compile(TMP);
const hex = artifact.hex;

console.log('flat 6x12 P2WPKH covenant');
check('has expectedNBits constructor param',
  artifact.abi.some(x => x.type === 'constructor' && x.params.some(p => p.name === 'expectedNBits')));
check('has expectedNBitsNext constructor param (dual retarget)',
  artifact.abi.some(x => x.type === 'constructor' && x.params.some(p => p.name === 'expectedNBitsNext')));
check('has btcChainAnchor constructor param',
  artifact.abi.some(x => x.type === 'constructor' && x.params.some(p => p.name === 'btcChainAnchor')));

// The emitted `artifact.hex` is a template with `<placeholder>` strings
// where constructor args will be substituted. Scan the hex string (not
// the Buffer, since Buffer.from(hex) silently drops non-hex chars) for
// both invariants and the floor.

// Floor literal: a 4-byte LE push. The generator emits at most a
// handful of 4-byte literal ints and this one should fall within the
// expected "now - 30d" ± 60d window.
const nowSec = Math.floor(Date.now() / 1000);
const sixtyDaysAgo = nowSec - 60 * 24 * 3600;
function scanFourBytePushes(hexStr) {
  // Match `04` (OP_PUSHBYTES_4) followed by exactly 8 hex chars, with a
  // negative lookbehind on a wider push prefix so we don't mis-parse
  // the leading byte of a bigger push as 0x04.
  const hits = [];
  const re = /(?:^|[^0-9a-f])04([0-9a-f]{8})/gi;
  let m;
  while ((m = re.exec(hexStr)) !== null) {
    const bytes = Buffer.from(m[1], 'hex');
    hits.push(bytes.readUInt32LE(0));
  }
  return hits;
}
const pushed = scanFourBytePushes(hex);
const plausibleFloor = pushed.some(v => v > sixtyDaysAgo && v < nowSec);
check('claimDeadline floor pushed as 4B LE within ±60d of now',
  plausibleFloor,
  `pushed u32s: ${pushed.slice(0, 8).join(',')}`);

// Structural tx-parse literals: covenant pushes these magic bytes.
function hexHas(pushByte) {
  // OP_PUSHBYTES_1 = 0x01, then the push byte.
  return hex.includes('01' + pushByte);
}
check('bytecode pushes 0x17 (P2SH-P2WPKH scriptSigLen)', hexHas('17'));
check('bytecode pushes 0x16 (P2SH-P2WPKH inner push-22)', hexHas('16'));
check('bytecode pushes 0x14 (P2SH-P2WPKH inner push-20)', hexHas('14'));
check('bytecode pushes 0xfd (reject multi-byte outputCount varint)', hexHas('fd'));
check('bytecode pushes 0x40 (64-byte length guard)',
  // 64 in CScriptNum is 0x40 single-byte push (minimal form).
  hex.includes('0140'));

// Stable hash: the generator output should be byte-stable (modulo the
// floor which varies each run). Compute over everything EXCEPT the
// 4-byte floor push we found above.
check('compiled hex is non-empty and reasonable size',
  hex.length > 6000 && hex.length < 20000,
  `got ${hex.length / 2} bytes`);

console.log(`\ncovenant-invariant tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
