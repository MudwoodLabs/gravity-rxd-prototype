/**
 * Bitcoin data fetching for SPV-proof construction.
 *
 * Uses mempool.space's public REST API. No API key, no Bitcoin node
 * required. For production you'd point this at your own Bitcoin node
 * (via RPC) or mirror the same endpoints.
 *
 * Endpoints used:
 *   GET /block-height/:height               → blockhash (plain text)
 *   GET /block/:hash/header                  → 80-byte header (hex)
 *   GET /tx/:txid/hex                        → raw tx (hex)
 *   GET /tx/:txid/merkle-proof               → { block_height, merkle, pos }
 *   GET /tx/:txid                            → tx metadata incl status.block_height
 */

const BASE = process.env.MEMPOOL_API || 'https://mempool.space/api';

async function getText(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.text()).trim();
}

async function getJSON(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

/** Block hash at given height (BE hex, 64 chars) */
async function getBlockHashAtHeight(height) {
  return await getText(`/block-height/${height}`);
}

/** 80-byte header as hex (little-endian fields as stored) */
async function getHeaderHex(blockHash) {
  const hex = await getText(`/block/${blockHash}/header`);
  if (hex.length !== 160) throw new Error(`expected 80-byte header, got ${hex.length / 2} bytes`);
  return hex;
}

/**
 * Fetch N consecutive headers starting at `startHeight`.
 * Returns an array of 80-byte hex strings.
 */
async function getHeaderChain(startHeight, count) {
  const headers = [];
  for (let i = 0; i < count; i++) {
    const height = startHeight + i;
    const hash = await getBlockHashAtHeight(height);
    const header = await getHeaderHex(hash);
    headers.push(header);
  }
  return headers;
}

/** Raw transaction as hex. This is the NON-witness serialization (suitable for hash256 → txid). */
async function getRawTx(txid) {
  return await getText(`/tx/${txid}/hex`);
}

/** Tx metadata: block_height, confirmations, etc. */
async function getTxMeta(txid) {
  return await getJSON(`/tx/${txid}`);
}

/**
 * Fetch Merkle proof:
 *   { block_height, merkle: [<sibling hashes>], pos: <tx position within block> }
 *
 * `merkle` is a flat array of sibling hash hex strings, one per level,
 * ordered from leaf level upward. Each hash is a BE hex string matching
 * what Bitcoin Core returns from `gettxoutproof`.
 *
 * `pos` is the transaction's leaf index in the block's Merkle tree.
 * Used to derive direction bytes per level: bit `i` of pos tells us
 * whether the sibling at level `i` is on the right (0) or left (1).
 */
async function getMerkleProof(txid) {
  return await getJSON(`/tx/${txid}/merkle-proof`);
}

module.exports = {
  getBlockHashAtHeight,
  getHeaderHex,
  getHeaderChain,
  getRawTx,
  getTxMeta,
  getMerkleProof,
};
