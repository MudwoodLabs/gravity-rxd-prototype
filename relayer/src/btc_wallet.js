/**
 * Bitcoin-side wallet tooling for Gravity participants.
 *
 * Handles:
 *   - P2PKH keypair generation (legacy format — required because covenant
 *     does hash256(raw_tx) which only equals txid for non-segwit txs)
 *   - UTXO queries via mempool.space
 *   - Legacy (non-segwit) payment tx construction + signing
 *   - Broadcast via mempool.space POST /tx
 *
 * Deliberately legacy-only. Segwit/Taproot would break the finalize()
 * covenant's hash256(raw_tx) == txid expectation.
 */

const crypto = require('crypto');
const ECPairFactory = require('ecpair').default;
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');

const ECPair = ECPairFactory(ecc);
const NETWORK = bitcoin.networks.bitcoin;

const MEMPOOL_API = process.env.MEMPOOL_API || 'https://mempool.space/api';

function generateKeypair() {
  const keypair = ECPair.makeRandom({ network: NETWORK });
  const pubkey = Buffer.from(keypair.publicKey);
  const { address } = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });

  // RIPEMD160(SHA256(pubkey))
  const sha = crypto.createHash('sha256').update(pubkey).digest();
  const pkh = crypto.createHash('ripemd160').update(sha).digest();

  return {
    privkey_wif: keypair.toWIF(),
    pubkey_hex: pubkey.toString('hex'),
    pkh_hex: pkh.toString('hex'),
    address,
  };
}

async function getUtxos(address) {
  const res = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`GET /address/${address}/utxo → ${res.status}`);
  return res.json();
}

async function getRawTxHex(txid) {
  const res = await fetch(`${MEMPOOL_API}/tx/${txid}/hex`);
  if (!res.ok) throw new Error(`GET /tx/${txid}/hex → ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Build and sign a legacy (non-segwit) P2PKH-to-P2PKH payment.
 *
 * @param {object} opts
 * @param {string} opts.privkeyWif    WIF private key for the sender's P2PKH input
 * @param {Array<{txid,vout,value}>} opts.inputs   UTXOs to spend (must all be P2PKH controlled by privkey)
 * @param {string} opts.toPkhHex      20-byte hex pkh of the destination
 * @param {number} opts.amountSats    amount to send to destination
 * @param {number} opts.feeSats       miner fee
 * @param {string} [opts.changeAddress]  if total input > amount+fee, send change here (defaults to sender's address)
 *
 * Returns { txHex, txId, size, fee, outputCount }.
 */
function buildSignedPaymentTx(opts) {
  const { privkeyWif, inputs, toPkhHex, amountSats, feeSats, changeAddress } = opts;
  const keypair = ECPair.fromWIF(privkeyWif, NETWORK);
  const pubkey = Buffer.from(keypair.publicKey);
  const { address: senderAddr } = bitcoin.payments.p2pkh({ pubkey, network: NETWORK });

  const totalIn = inputs.reduce((s, u) => s + u.value, 0);
  const changeSats = totalIn - amountSats - feeSats;
  if (changeSats < 0) throw new Error(`insufficient funds: in=${totalIn}, out=${amountSats}+${feeSats}`);

  const tx = new bitcoin.Transaction();
  tx.version = 1;  // legacy

  // Add inputs (without scriptSig yet — we'll sign below)
  for (const u of inputs) {
    const prevHash = Buffer.from(u.txid, 'hex').reverse();
    tx.addInput(prevHash, u.vout, 0xffffffff);
  }

  // Output 0: payment to target pkh (P2PKH)
  const destScript = bitcoin.payments.p2pkh({ hash: Buffer.from(toPkhHex, 'hex'), network: NETWORK }).output;
  tx.addOutput(destScript, BigInt(amountSats));

  // Output 1: change (if any, above dust)
  if (changeSats >= 546) {
    const changeAddr = changeAddress || senderAddr;
    const changeScript = bitcoin.address.toOutputScript(changeAddr, NETWORK);
    tx.addOutput(changeScript, BigInt(changeSats));
  }
  // Otherwise, change < dust: add to fee.

  // Sign each input using legacy SIGHASH_ALL.
  const senderScript = bitcoin.payments.p2pkh({ pubkey, network: NETWORK }).output;
  for (let i = 0; i < inputs.length; i++) {
    const hashForSig = tx.hashForSignature(i, senderScript, bitcoin.Transaction.SIGHASH_ALL);
    const rawSig = Buffer.from(keypair.sign(hashForSig));
    const signature = bitcoin.script.signature.encode(rawSig, bitcoin.Transaction.SIGHASH_ALL);
    const scriptSig = bitcoin.script.compile([signature, pubkey]);
    tx.setInputScript(i, scriptSig);
  }

  const txHex = tx.toHex();
  return {
    txHex,
    txId: tx.getId(),
    size: Buffer.from(txHex, 'hex').length,
    fee: feeSats,
    outputCount: tx.outs.length,
    change: changeSats >= 546 ? changeSats : 0,
    feeSwept: changeSats >= 0 && changeSats < 546 ? changeSats : 0,
  };
}

async function broadcastTx(txHex) {
  const res = await fetch(`${MEMPOOL_API}/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: txHex,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`POST /tx → ${res.status}: ${errText}`);
  }
  return (await res.text()).trim();  // txid
}

module.exports = {
  generateKeypair,
  getUtxos,
  getRawTxHex,
  buildSignedPaymentTx,
  broadcastTx,
};
