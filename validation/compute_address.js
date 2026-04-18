#!/usr/bin/env node
/**
 * Compute the Radiant address where a covenant UTXO should be funded.
 *
 * Takes a compiled artifact (produced by rxdc), renders its raw hex
 * (with constructor args substituted if any), and computes the P2SH
 * address that a funding transaction should pay to.
 *
 * For verify_header.rxd the contract has no constructor args, so the
 * hex can be used as-is.
 *
 * Usage:
 *   node compute_address.js <artifact.json>
 *
 * Output:
 *   - Locking script hex (the thing a funding tx's output script is)
 *   - P2SH locking script hex (what you'd actually put in a funding tx vout)
 *   - Address (base58 / cash-address) for standard funding wallets
 */

const fs = require('fs');
const rxd = require('@radiant-core/radiantjs');

function main() {
  const artifactPath = process.argv[2];
  if (!artifactPath) {
    console.error('usage: compute_address.js <artifact.json>');
    process.exit(2);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

  const hex = artifact.hex;
  if (hex.includes('<')) {
    console.error('Artifact still has unfilled constructor placeholders:');
    console.error(hex);
    console.error('');
    console.error('Contracts with constructor args: fill them before computing an address.');
    process.exit(1);
  }

  const scriptBuf = Buffer.from(hex, 'hex');
  const script = rxd.Script.fromBuffer(scriptBuf);

  // P2SH wrapping: the funding tx pays to HASH160(covenant script), and the
  // spender reveals the script + unlock data as the redeem script.
  const p2shAddress = rxd.Address.payingTo(script);
  const p2shLockingScript = rxd.Script.buildScriptHashOut(p2shAddress);

  console.log('=== ' + artifact.contract + ' ===');
  console.log(`ASM:             ${artifact.asm.slice(0, 80)}${artifact.asm.length > 80 ? ' ...' : ''}`);
  console.log(`Script size:     ${scriptBuf.length} bytes`);
  console.log(`Opcode count:    ${artifact.asm.split(' ').length}`);
  console.log('');
  console.log(`Covenant script hex (full redeem script; spender reveals this):`);
  console.log(hex);
  console.log('');
  console.log(`P2SH address (send funding tx here):`);
  console.log(`  ${p2shAddress.toString()}`);
  console.log('');
  console.log(`P2SH locking script hex (what a funding tx's output will contain):`);
  console.log(`  ${p2shLockingScript.toHex()}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Send a small amount of photons (e.g. 10,000) to the P2SH address above.`);
  console.log(`  2. Record the funding txid and the output index (vout) that paid the P2SH.`);
  console.log(`  3. Run build_spending_tx.js with those values to construct the unlock tx.`);
}

main();
