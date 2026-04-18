/**
 * Convert Bitcoin SPV proof data into the wire format our covenant expects.
 *
 * Covenant expects `branch` = concatenation of M × 33-byte entries:
 *   [direction_byte][32_byte_sibling_hash_LE]
 *
 * where direction_byte = 0x00 means sibling on right (current on left),
 *        direction_byte = 0x01 means sibling on left (current on right).
 *
 * mempool.space / Bitcoin Core return:
 *   merkle: array of hex strings, one per tree level from leaf upward
 *   pos:    0-indexed position of the tx in the block's flat leaf list
 *
 * Direction at level `i` is derived from bit `i` of pos:
 *   if (pos >> i) & 1 == 0: current is on the left  → sibling on right (0x00)
 *   if (pos >> i) & 1 == 1: current is on the right → sibling on left  (0x01)
 *
 * Sibling hash endianness: Bitcoin Core's gettxoutproof and mempool.space
 * both return hashes in BE display order. The covenant's hash256 opcodes
 * produce LE. Bitcoin internally hashes LE-concatenated children to get
 * LE parents. So the sibling hashes in the branch must be in LE order
 * when compared against hash256 output.
 *
 * mempool.space returns BE hashes, so we must reverse each before
 * including in the branch.
 */

function buildBranch(merkleBE, pos) {
  const parts = [];
  for (let i = 0; i < merkleBE.length; i++) {
    const dir = ((pos >> i) & 1) === 0 ? 0x00 : 0x01;
    const siblingBE = Buffer.from(merkleBE[i], 'hex');
    if (siblingBE.length !== 32) {
      throw new Error(`sibling[${i}] is ${siblingBE.length} bytes, expected 32`);
    }
    const siblingLE = Buffer.from(siblingBE).reverse();
    parts.push(Buffer.from([dir]));
    parts.push(siblingLE);
  }
  return Buffer.concat(parts);
}

/**
 * Given the leaf txid (BE hex, as returned by mempool) and a branch,
 * walk up the tree and return the computed root (LE bytes — matches
 * how the covenant extracts merkleRoot from the header).
 *
 * Used for off-chain validation before submitting to the covenant.
 */
function computeRoot(txidBE, branchBuf) {
  const crypto = require('crypto');
  const hash256 = (b) => crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(b).digest()
  ).digest();

  // Start with leaf hash in LE (reverse of BE display form)
  let current = Buffer.from(txidBE, 'hex').reverse();

  if (branchBuf.length % 33 !== 0) throw new Error('branch not a multiple of 33 bytes');
  const depth = branchBuf.length / 33;
  for (let i = 0; i < depth; i++) {
    const dir = branchBuf[i * 33];
    const sib = branchBuf.slice(i * 33 + 1, i * 33 + 33);
    if (dir === 0) {
      current = hash256(Buffer.concat([current, sib]));
    } else {
      current = hash256(Buffer.concat([sib, current]));
    }
  }
  return current;  // LE
}

/**
 * Extract the merkle root from an 80-byte header (stored LE).
 * merkleRoot field is at offset 36..68 in the header.
 */
function extractMerkleRoot(headerHex) {
  return Buffer.from(headerHex, 'hex').slice(36, 68);  // LE, 32 bytes
}

module.exports = { buildBranch, computeRoot, extractMerkleRoot };
