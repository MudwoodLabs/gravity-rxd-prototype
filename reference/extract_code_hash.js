#!/usr/bin/env node
/**
 * Extract the `expectedClaimedCodeHash` value needed for a Maker to bind
 * their MakerOffer to a specific MakerClaimed template.
 *
 * Given:
 *   - A compiled artifact.json produced by `rxdc <contract>.rxd -o out.json`
 *   - Constructor argument values for code-section params (for MakerClaimed:
 *     makerPkh and totalPhotonsInOutput)
 *
 * Produces:
 *   - The hex of the MakerClaimed CODE script (bytes after OP_STATESEPARATOR)
 *     with constructor args substituted
 *   - HASH256 of that code script → this is what goes into MakerOffer's
 *     `expectedClaimedCodeHash` constructor parameter
 *
 * Usage:
 *   node extract_code_hash.js <artifact.json> key=hexvalue key=intvalue ...
 *
 * Example:
 *   node extract_code_hash.js /tmp/maker_claimed.json \
 *     makerPkh=aabbccddeeff00112233445566778899aabbccdd \
 *     totalPhotonsInOutput=1000000
 *
 * The substitution keys must match the artifact's constructor param names.
 */

const crypto = require('crypto');
const fs = require('fs');

const OP_STATESEPARATOR = 0xbd;

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

/**
 * Encode an integer as minimally-encoded CScriptNum + push prefix.
 * Matches what rxdc emits for int constructor args.
 */
function encodeIntPush(n) {
  if (n === 0) return Buffer.from([0x00]); // OP_0
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]); // OP_1..OP_16
  const neg = n < 0;
  let v = Math.abs(n);
  const bytes = [];
  while (v > 0) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(neg ? 0x80 : 0x00);
  } else if (neg) {
    bytes[bytes.length - 1] |= 0x80;
  }
  const body = Buffer.from(bytes);
  const len = body.length;
  if (len <= 75) return Buffer.concat([Buffer.from([len]), body]);
  if (len <= 255) return Buffer.concat([Buffer.from([0x4c, len]), body]);
  throw new Error(`int push length ${len} not supported`);
}

/**
 * Encode a fixed-length byte value with a minimal push prefix.
 * Ripemd160 (bytes20) → 0x14 <20 bytes>. Bytes32 → 0x20 <32 bytes>.
 */
function encodeBytesPush(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const len = bytes.length;
  if (len <= 75) return Buffer.concat([Buffer.from([len]), bytes]);
  if (len <= 255) return Buffer.concat([Buffer.from([0x4c, len]), bytes]);
  throw new Error(`bytes push length ${len} not supported`);
}

function substitute(hexTemplate, params, abi) {
  const constructor = abi.find(x => x.type === 'constructor');
  if (!constructor) throw new Error('no constructor in ABI');

  let result = hexTemplate;
  for (const p of constructor.params) {
    const val = params[p.name];
    if (val === undefined) throw new Error(`missing value for constructor param ${p.name}`);

    const placeholder = `<${p.name}>`;
    if (!result.includes(placeholder)) {
      throw new Error(`placeholder ${placeholder} not in hex template`);
    }

    let encoded;
    if (p.type === 'int') {
      encoded = encodeIntPush(Number(val));
    } else if (p.type === 'Ripemd160' || p.type.startsWith('Bytes')) {
      encoded = encodeBytesPush(val);
    } else {
      throw new Error(`unsupported constructor param type ${p.type}`);
    }

    // Replace all occurrences (constructor args can appear multiple times)
    result = result.split(placeholder).join(encoded.toString('hex'));
  }

  // Check no placeholders remain
  const unfilled = result.match(/<\w+>/g);
  if (unfilled) throw new Error(`unfilled placeholders: ${unfilled.join(', ')}`);

  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: extract_code_hash.js <artifact.json> key=value ...');
    process.exit(2);
  }
  const artifactPath = args[0];
  const params = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf('=');
    if (eq < 0) { console.error(`bad arg ${a}`); process.exit(2); }
    params[a.slice(0, eq)] = a.slice(eq + 1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  const fullHex = substitute(artifact.hex, params, artifact.abi);
  const fullBytes = Buffer.from(fullHex, 'hex');

  // Find OP_STATESEPARATOR (0xbd). Use the FIRST occurrence — that's the
  // language-level separator. Any 0xbd inside push data is not a separator.
  // For this contract template, there are no long push-data sections that
  // could contain 0xbd, so a first-match search is safe. For more complex
  // contracts, a real byte-by-byte script walker is needed.
  const sepIdx = fullBytes.indexOf(OP_STATESEPARATOR);
  if (sepIdx < 0) {
    console.error('OP_STATESEPARATOR (0xbd) not found in compiled bytecode');
    console.error('hex:', fullHex);
    process.exit(1);
  }

  // Per Radiant-Core interpreter.cpp (OP_CODESCRIPTBYTECODE_OUTPUT impl at
  // interpreter.cpp ~line 2337), the "code script" is bytes
  // [stateSeparatorIndex .. end], INCLUDING the separator byte itself:
  //   stack.emplace_back(outputScript.begin() + stateSeperatorIndex, outputScript.end());
  // The "state script" is bytes [0 .. stateSeparatorIndex - 1] (EXCLUDING
  // the separator — see OP_STATESCRIPTBYTECODE_UTXO impl).
  //
  // So codeScript starts at sepIdx, not sepIdx + 1. This is the hash that
  // an on-chain MakerOffer's claim() check will produce via OP_HASH256 on
  // the result of OP_CODESCRIPTBYTECODE_OUTPUT.
  const codeScript = fullBytes.slice(sepIdx);  // bytes FROM the separator (inclusive)
  const codeHash = hash256(codeScript);

  console.log(`# MakerClaimed code-hash extraction`);
  console.log(`contract:            ${artifact.contract}`);
  console.log(`params:              ${JSON.stringify(params)}`);
  console.log(`full locking hex:    ${fullHex}`);
  console.log(`state separator at:  byte ${sepIdx} (of ${fullBytes.length})`);
  console.log(`code script hex:     ${codeScript.toString('hex')}`);
  console.log(`code script length:  ${codeScript.length} bytes`);
  console.log('');
  console.log(`expectedClaimedCodeHash (hex, 32 bytes):`);
  console.log(codeHash.toString('hex'));
}

main();
