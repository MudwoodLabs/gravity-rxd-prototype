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
bitcoin.initEccLib(ecc);  // required for taproot (p2tr) operations
const NETWORK = bitcoin.networks.bitcoin;

const MEMPOOL_API = process.env.MEMPOOL_API || 'https://mempool.space/api';

/**
 * Generate a fresh Bitcoin keypair and return addresses in all 4 formats
 * supported by the multi-type Gravity covenant.
 *
 * Maker chooses which format they want to use as `btcReceiveHash` +
 * `btcReceiveType` based on wallet / ecosystem preference.
 */
function generateKeypair() {
  const keypair = ECPair.makeRandom({ network: NETWORK });
  const pubkey = Buffer.from(keypair.publicKey);

  // RIPEMD160(SHA256(pubkey)) — 20 bytes. Used for P2PKH + P2WPKH.
  const sha = crypto.createHash('sha256').update(pubkey).digest();
  const pkh = crypto.createHash('ripemd160').update(sha).digest();

  // P2SH-P2WPKH: the redeem script is `OP_0 <20-byte pkh>`, script-hash
  // is RIPEMD160(SHA256(redeem)). The pattern is widely used for "segwit
  // addresses that look like legacy 3..." addresses.
  const p2shRedeem = Buffer.concat([Buffer.from([0x00, 0x14]), pkh]);
  const p2shInnerSha = crypto.createHash('sha256').update(p2shRedeem).digest();
  const p2shHash = crypto.createHash('ripemd160').update(p2shInnerSha).digest();

  // P2TR: the "hash" is actually the x-only (32-byte) tweaked output pubkey.
  // bitcoinjs-lib p2tr API requires explicit internal key + tweak derivation.
  // For a fresh keypair we can use the pubkey's x-coordinate as internal
  // key and apply the BIP341 "no-script-path" tweak.
  //
  // NOTE: tiny-secp256k1 supports xOnlyPointAddTweak. We use that here to
  // produce a proper P2TR output key. For simplicity the test scripts can
  // also just use a 32-byte random key as the output; the covenant only
  // checks equality.
  const xOnlyPubkey = pubkey.slice(1);  // remove parity byte
  const tweakHash = crypto.createHash('sha256')
    .update(Buffer.from('TapTweak', 'utf8')).digest();
  const tapTweakHash = crypto.createHash('sha256').update(
    Buffer.concat([tweakHash, tweakHash, xOnlyPubkey])
  ).digest();
  const tweaked = ecc.xOnlyPointAddTweak(xOnlyPubkey, tapTweakHash);
  const p2trOutputKey = tweaked ? Buffer.from(tweaked.xOnlyPubkey) : xOnlyPubkey;

  return {
    privkey_wif: keypair.toWIF(),
    pubkey_hex: pubkey.toString('hex'),

    // Primary fields (20-byte hash used by P2PKH and P2WPKH)
    pkh_hex: pkh.toString('hex'),

    // Per-format fields — use the one matching your chosen btcReceiveType
    p2pkh: {
      type: 0,
      hash_hex: pkh.toString('hex'),
      address: bitcoin.payments.p2pkh({ pubkey, network: NETWORK }).address,
    },
    p2wpkh: {
      type: 1,
      hash_hex: pkh.toString('hex'),
      address: bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }).address,
    },
    p2sh_p2wpkh: {
      type: 2,
      hash_hex: p2shHash.toString('hex'),
      address: bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey, network: NETWORK }),
        network: NETWORK,
      }).address,
    },
    p2tr: {
      type: 3,
      hash_hex: p2trOutputKey.toString('hex'),
      address: bitcoin.payments.p2tr({
        internalPubkey: xOnlyPubkey,
        network: NETWORK,
      }).address,
    },
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

/**
 * Strip witness data from a segwit-serialized Bitcoin tx, returning the
 * non-witness (legacy) serialization whose hash256 equals the txid.
 *
 * Gravity's finalize() covenant computes hash256(rawTx) to derive the
 * Merkle leaf. For segwit/taproot txs, the full serialization includes
 * witness data and hash256 gives the wtxid, not the txid. Stripping the
 * marker/flag/witness produces the non-witness serialization.
 *
 * If the input is already a non-witness (legacy) tx, returns it unchanged.
 *
 * @param {string} rawTxHex  the raw tx hex (possibly segwit)
 * @returns {{
 *   nonWitnessHex: string,
 *   wasSegwit: boolean,
 *   inputCount: number,
 *   outputCount: number
 * }}
 */
function stripWitness(rawTxHex) {
  const tx = bitcoin.Transaction.fromHex(rawTxHex);
  const wasSegwit = tx.hasWitnesses();

  // bitcoinjs-lib's Transaction has separate virtual/byteLength methods.
  // To serialize without witness, clear the witness data and re-serialize.
  if (!wasSegwit) {
    return {
      nonWitnessHex: rawTxHex,
      wasSegwit: false,
      inputCount: tx.ins.length,
      outputCount: tx.outs.length,
    };
  }

  // Clone the tx without witness data, then serialize.
  // bitcoinjs-lib encodes the non-witness version when hasWitnesses() is false.
  // Easiest: zero-out every input's witness array, then toHex().
  for (const input of tx.ins) {
    input.witness = [];
  }

  return {
    nonWitnessHex: tx.toHex(),
    wasSegwit: true,
    inputCount: tx.ins.length,
    outputCount: tx.outs.length,
  };
}

module.exports = {
  generateKeypair,
  getUtxos,
  getRawTxHex,
  buildSignedPaymentTx,
  broadcastTx,
  stripWitness,
};
