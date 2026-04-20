#!/usr/bin/env node
/**
 * Compute the expectedClaimedCodeHash for a MakerOffer that binds to a
 * P2SH-wrapped MakerClaimed (or flat MakerCovenant) UTXO.
 *
 * Rationale: our covenants are deployed as P2SH. The P2SH scriptPubKey is
 *   OP_HASH160 <20-byte script-hash> OP_EQUAL
 * which is 23 bytes. Radiant's OP_CODESCRIPTBYTECODE_OUTPUT on such an
 * output returns the entire scriptPubKey (stateSeparator logic doesn't
 * apply — there's no separator in a bare P2SH wrapper).
 *
 * So `hash256(tx.outputs[0].codeScript) == expectedClaimedCodeHash` on
 * an on-chain MakerOffer matches iff output[0] is P2SH to a specific
 * script-hash. That script-hash is determined by the full MakerClaimed
 * locking bytecode (state + code, whatever Radiant considers them).
 *
 * Usage:
 *   node extract_p2sh_code_hash.js <artifact.json> key=hexvalue key=intvalue ...
 *
 * Output:
 *   - The substituted full covenant bytecode
 *   - Its RIPEMD160(SHA256(...)) script-hash
 *   - The resulting P2SH scriptPubKey
 *   - hash256 of the P2SH scriptPubKey → this goes in MakerOffer
 */

const crypto = require('crypto');
const fs = require('fs');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function encodeIntPush(n) {
  if (n === 0) return Buffer.from([0x00]);
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]);
  const neg = n < 0;
  let v = Math.abs(n);
  const bytes = [];
  while (v > 0) { bytes.push(v & 0xff); v = Math.floor(v / 256); }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(neg ? 0x80 : 0x00);
  else if (neg) bytes[bytes.length - 1] |= 0x80;
  const body = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function encodeBytesPush(hex) {
  const b = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.from([b.length]), b]);
}

function substitute(hexTemplate, params, abi) {
  const constructor = abi.find(x => x.type === 'constructor');
  if (!constructor) throw new Error('no constructor in ABI');

  let result = hexTemplate;
  for (const p of constructor.params) {
    const val = params[p.name];
    if (val === undefined) throw new Error(`missing value for param ${p.name}`);

    const placeholder = `<${p.name}>`;
    if (!result.includes(placeholder)) continue;

    const encoded = p.type === 'int'
      ? encodeIntPush(Number(val))
      : encodeBytesPush(val);

    result = result.split(placeholder).join(encoded.toString('hex'));
  }

  const unfilled = result.match(/<\w+>/g);
  if (unfilled) throw new Error(`unfilled: ${unfilled.join(', ')}`);
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('usage: extract_p2sh_code_hash.js <artifact.json> key=value ...');
    process.exit(2);
  }
  const artifact = JSON.parse(fs.readFileSync(args[0], 'utf-8'));

  // Refuse known-insecure contract templates. These are kept in
  // `contracts/legacy/` for historical reference, but an operator running
  // this tool against their artifact would produce a deployable P2SH with
  // missing security checks (permissionless claim, no SPV verify, etc.).
  const BANNED = {
    'MakerOfferSimple': 'skips Taker signature on claim — audit 04 S3 (grief vector)',
    'MakerClaimedStub': 'finalize() has no SPV check — any party could drain the UTXO',
    'MakerClaimed': 'hand-written reference; use generator output',
    'MakerCovenant6x12': 'pre-Phase-4 covenant — no nBits bound, no structural constraint. Regenerate.',
    'MakerCovenantFlat6x12': 'pre-Phase-4 covenant — no nBits bound, no structural constraint. Regenerate.',
    'VerifyPayment': 'standalone primitive, not a deployable covenant',
  };
  if (BANNED[artifact.contract]) {
    const bypass = process.argv.includes('--i-understand-legacy-artifact=true');
    console.error(
      `\nartifact.contract = "${artifact.contract}" is on the deny-list:\n` +
      `  ${BANNED[artifact.contract]}\n\n` +
      (bypass
        ? `Proceeding per --i-understand-legacy-artifact=true.`
        : `Refusing to compute. For a real deployment, regenerate from\n` +
          `generators/gen_maker_covenant.js, compile the output, and rerun\n` +
          `this tool on the new artifact. To bypass (for research / audit\n` +
          `recomputation), pass --i-understand-legacy-artifact=true.\n`)
    );
    if (!bypass) process.exit(2);
  }

  const params = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf('=');
    if (eq < 0) { console.error(`bad arg ${a}`); process.exit(2); }
    params[a.slice(0, eq)] = a.slice(eq + 1);
  }

  // S1 defense: refuse to compute a P2SH commitment with a claimDeadline
  // that's not comfortably in the future. The covenant's own floor is a
  // static generation-time constant which can go stale; this belt-and-
  // suspenders client-side check catches the common footgun where a Maker
  // (or an attacker crafting an offer for a specific target) supplies
  // claimDeadline = 0 / past / near-present.
  if (params.claimDeadline !== undefined) {
    const cd = Number(params.claimDeadline);
    const now = Math.floor(Date.now() / 1000);
    const minFuture = now + 24 * 3600;
    if (!Number.isFinite(cd)) {
      console.error(`claimDeadline=${params.claimDeadline} is not a valid number`);
      process.exit(2);
    }
    if (cd < minFuture) {
      const short = minFuture - cd;
      const bypassed = params['--i-understand-short-deadline'] === 'true';
      if (!bypassed) {
        console.error(
          `\nclaimDeadline=${cd} is ${short}s short of now+24h.\n\n` +
          `Refusing to compute — with a near-past/present deadline the\n` +
          `forfeit() path opens almost immediately, so the Maker can race\n` +
          `the Taker's claim (audit 04 finding S1).\n\n` +
          `⚠️ DO NOT pass --i-understand-short-deadline=true if a\n` +
          `counter-party asked you to. They may be constructing an offer\n` +
          `designed to grief you out of your bond. The flag exists only for\n` +
          `time-boxed use-cases YOU set yourself (test harness, OTC desk\n` +
          `with explicit short-deadline contracts).\n`
        );
        process.exit(2);
      }
      console.error(
        `claimDeadline=${cd} is ${short}s short of now+24h; proceeding ` +
        `per --i-understand-short-deadline=true. If someone else asked you ` +
        `to pass this flag, STOP — this is a grief-attack pattern.`
      );
    }
  }

  const fullHex = substitute(artifact.hex, params, artifact.abi);
  const redeemScript = Buffer.from(fullHex, 'hex');

  // P2SH scriptPubKey: OP_HASH160 <20-byte script-hash> OP_EQUAL
  const scriptHash = hash160(redeemScript);
  const p2shScriptPubKey = Buffer.concat([
    Buffer.from([0xa9, 0x14]),  // OP_HASH160 <push20>
    scriptHash,
    Buffer.from([0x87]),        // OP_EQUAL
  ]);

  const codeHash = hash256(p2shScriptPubKey);

  console.log(`# MakerOffer expectedClaimedCodeHash extraction (P2SH)`);
  console.log(`contract:               ${artifact.contract}`);
  console.log(`params:                 ${JSON.stringify(params)}`);
  console.log(`redeem script length:   ${redeemScript.length} bytes`);
  console.log(`script-hash (RIPEMD160-SHA256): ${scriptHash.toString('hex')}`);
  console.log(`P2SH scriptPubKey (23 B hex):   ${p2shScriptPubKey.toString('hex')}`);
  console.log('');
  console.log(`expectedClaimedCodeHash (for MakerOffer):`);
  console.log(codeHash.toString('hex'));
}

main();
