#!/usr/bin/env node
/**
 * ⚠️ THIS HELPER IS UNUSED FOR THE CURRENT P2SH DEPLOYMENT FORM.
 *
 * The repo's MakerOffer / MakerClaimed covenants are always deployed as
 * P2SH-wrapped scripts (see HANDOFF.md). For P2SH deployments, the
 * covenant's claim() check `hash256(tx.outputs[0].codeScript) ==
 * expectedClaimedCodeHash` compares against the 23-byte P2SH
 * scriptPubKey (`OP_HASH160 <20B script-hash> OP_EQUAL`), NOT the bytes
 * after OP_STATESEPARATOR.
 *
 * → Use `reference/extract_p2sh_code_hash.js` for every real deployment.
 * → This file (`extract_code_hash_NON_P2SH_UNUSED.js`) would only be
 *   correct if the covenant were deployed as a bare stateSeparator
 *   contract without a P2SH wrapper. That form is not used in this
 *   prototype and its binding semantics haven't been tested on Radiant
 *   mainnet. Running this tool against a P2SH-deployed MakerClaimed
 *   template will produce a hash that NEVER MATCHES on-chain — the
 *   MakerOffer will refuse to advance state, permanently locking Maker's
 *   RXD in the offer UTXO until cancel().
 *
 * Original intent (kept for reference only):
 *
 * Given:
 *   - A compiled artifact.json produced by `rxdc <contract>.rxd -o out.json`
 *   - Constructor argument values for code-section params
 *
 * Produces:
 *   - HASH256 of the code script bytes from OP_STATESEPARATOR onward.
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

// Find the first position where `opcode` appears as a real script opcode
// (not as a byte inside a push-data region). Returns -1 if not found.
// Handles 0x01..0x4b direct pushes, 0x4c OP_PUSHDATA1, 0x4d OP_PUSHDATA2,
// 0x4e OP_PUSHDATA4, and treats all other bytes as 1-byte opcodes.
function findOpcode(bytes, opcode) {
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    if (op === opcode) return i;
    if (op >= 0x01 && op <= 0x4b) {
      i += 1 + op;
    } else if (op === 0x4c) {
      if (i + 1 >= bytes.length) break;
      i += 2 + bytes[i + 1];
    } else if (op === 0x4d) {
      if (i + 2 >= bytes.length) break;
      i += 3 + bytes.readUInt16LE(i + 1);
    } else if (op === 0x4e) {
      if (i + 4 >= bytes.length) break;
      i += 5 + bytes.readUInt32LE(i + 1);
    } else {
      i += 1;
    }
  }
  return -1;
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
  // Refuse to run without explicit opt-in. P2SH deployments MUST use
  // extract_p2sh_code_hash.js instead; running this one by mistake
  // permanently locks the Maker's RXD in the offer.
  if (!args.includes('--i-understand-this-is-not-for-p2sh=true')) {
    console.error(
      '\nThis tool is for non-P2SH (bare stateSeparator) covenant\n' +
      'deployments — which are NOT what this repo uses. Running it on\n' +
      'a P2SH-deployed MakerClaimed template will lock the Maker offer.\n\n' +
      'For every real deployment, use:\n' +
      '  node reference/extract_p2sh_code_hash.js <artifact.json> \\\n' +
      '       makerPkh=... totalPhotonsInOutput=... (etc.)\n\n' +
      'If you are sure you want the stateSeparator-only code hash for\n' +
      'research, re-run with --i-understand-this-is-not-for-p2sh=true.\n'
    );
    process.exit(2);
  }
  if (args.length < 2) {
    console.error('usage: extract_code_hash_NON_P2SH_UNUSED.js <artifact.json> key=value ... --i-understand-this-is-not-for-p2sh=true');
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

  // Find OP_STATESEPARATOR (0xbd) as a real opcode — not as a byte inside
  // push-data. A naive indexOf is unsafe because a short bytes20 push
  // (takerRadiantPkh) has a ~7.6% chance of containing 0xbd in some byte.
  const sepIdx = findOpcode(fullBytes, OP_STATESEPARATOR);
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
