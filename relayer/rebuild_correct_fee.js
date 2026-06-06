const crypto = require('crypto');
const fs = require('fs');
const rxd = require('@radiant-core/radiantjs');
const { buildFinalizeTx } = require('./src/finalize_tx.js');

function hash256(buf) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(buf).digest()
  ).digest();
}

const proof2 = JSON.parse(fs.readFileSync('/tmp/spv-proof2.json', 'utf8'));
const redeemHex1 = fs.readFileSync('/tmp/claimed_redeem.hex', 'utf8').trim();
const MAKER_WIF = fs.readFileSync('/tmp/maker-rxd.wif', 'utf8').trim();
const MAKER_PRIV = new rxd.PrivateKey(MAKER_WIF);
const MAKER_ADDR = MAKER_PRIV.toPublicKey().toAddress().toString();
const TAKER_ADDR = '1JArrpvMqWyf7EMVVQzdgqXnHcgwZ71C8p';
const UTXO1 = { txid: '60dbbdd677e9c263fa361513cef66da4e12c52c32682c307c94effc9489648b9', vout: 0, amount: 147000000 };
const CLAIM_DEADLINE = 1776889595;

// 0.10 RXD/kB = 10000 photons/byte (in Radiant, 1 RXD = 10^8 photons)
// 5372 bytes * 10000 = 53720000 photons minimum for finalize txs
// 4366 bytes * 10000 = 43660000 photons minimum for forfeit tx
const FEE_FINALIZE = 60000000; // 0.60 RXD
const FEE_FORFEIT  = 50000000; // 0.50 RXD

// ATTACK 1: Tampered Merkle Branch
{
  const p = JSON.parse(JSON.stringify(proof2));
  const branchBuf = Buffer.from(p.branch, 'hex');
  branchBuf[5] ^= 0xff;
  p.branch = branchBuf.toString('hex');
  const r = buildFinalizeTx({ spvProof: p, redeemHex: redeemHex1, fundingTxid: UTXO1.txid, fundingVout: UTXO1.vout, fundingAmount: UTXO1.amount, toAddress: TAKER_ADDR, feeSats: FEE_FINALIZE });
  fs.writeFileSync('/tmp/attack1.hex', r.txHex);
  console.log(`Attack1: txid=${r.txId} size=${r.txSize}B fee=${FEE_FINALIZE} photons (${(FEE_FINALIZE/1e8).toFixed(4)} RXD)`);
}

// ATTACK 2: Fake Payment Hash
{
  const rawTxBuf = Buffer.from(proof2.raw_tx, 'hex');
  Buffer.alloc(20, 0xaa).copy(rawTxBuf, 58);
  const fakeTxid = hash256(rawTxBuf).reverse().toString('hex');
  const fakeProof = JSON.parse(JSON.stringify(proof2));
  fakeProof.raw_tx = rawTxBuf.toString('hex');
  fakeProof.txid = fakeTxid;
  const r = buildFinalizeTx({ spvProof: fakeProof, redeemHex: redeemHex1, fundingTxid: UTXO1.txid, fundingVout: UTXO1.vout, fundingAmount: UTXO1.amount, toAddress: TAKER_ADDR, feeSats: FEE_FINALIZE });
  fs.writeFileSync('/tmp/attack2.hex', r.txHex);
  console.log(`Attack2: txid=${r.txId} size=${r.txSize}B fee=${FEE_FINALIZE}`);
}

// ATTACK 3: Early Forfeit
{
  const redeemScriptBuf = Buffer.from(redeemHex1, 'hex');
  const redeemScript = rxd.Script.fromBuffer(redeemScriptBuf);
  const p2shAddress = rxd.Address.payingTo(redeemScript);
  const p2shScriptPubKey = rxd.Script.buildScriptHashOut(p2shAddress);
  const utxo = new rxd.Transaction.UnspentOutput({ txId: UTXO1.txid, outputIndex: UTXO1.vout, address: p2shAddress.toString(), script: p2shScriptPubKey.toHex(), satoshis: UTXO1.amount });
  const tx = new rxd.Transaction();
  tx.from(utxo);
  tx.to(MAKER_ADDR, UTXO1.amount - FEE_FORFEIT);
  const scriptSig = rxd.Script.empty().add(rxd.Opcode.OP_1).add(redeemScriptBuf);
  tx.inputs[0].setScript(scriptSig);
  tx.inputs[0].sequenceNumber = 0xFFFFFFFE;
  const now = Math.floor(Date.now() / 1000);
  tx.nLockTime = now;
  const txHex = tx.serialize({ disableAll: true });
  fs.writeFileSync('/tmp/attack3.hex', txHex);
  console.log(`Attack3: txid=${tx.id} size=${Buffer.from(txHex,'hex').length}B fee=${FEE_FORFEIT} nLockTime=${now} deadline=${CLAIM_DEADLINE}`);
}

// ATTACK 4B: Proof Reuse (proof2 against attempt-1 UTXO + redeem)
{
  const r = buildFinalizeTx({ spvProof: proof2, redeemHex: redeemHex1, fundingTxid: UTXO1.txid, fundingVout: UTXO1.vout, fundingAmount: UTXO1.amount, toAddress: TAKER_ADDR, feeSats: FEE_FINALIZE });
  fs.writeFileSync('/tmp/attack4b.hex', r.txHex);
  console.log(`Attack4b: txid=${r.txId} size=${r.txSize}B fee=${FEE_FINALIZE}`);
}
