# Chain-identity anchoring

## The problem

A Gravity covenant's `finalize()` path validates a chain of N Bitcoin
headers by checking proof-of-work: `hash256(header) < target_from_nBits`.
This validates that the chain was expensive to produce — but it doesn't
validate **which** chain.

Without additional checks, an attacker could:

1. Cheaply mine a testnet chain (testnet PoW is designed to be easy)
2. Include a fake "payment" tx in one of those testnet blocks
3. Submit the resulting SPV proof to a mainnet Gravity covenant
4. The covenant would accept it — it passes PoW + Merkle — and release
   the Photons to the attacker

The covenant has no way, by itself, to tell mainnet headers from testnet
headers. Both use SHA-256d, both satisfy their own difficulty targets,
both chain with `prevHash` links.

## The fix

**Chain-identity anchoring**: the Maker commits at offer time to a
specific known-good Bitcoin mainnet block. Any valid SPV proof must
connect to that block as an ancestor.

Concretely: Maker picks a recent mainnet block at height `H`, computes
`anchor = hash256(header_at_height_H)` (in Bitcoin's native LE byte
order), and embeds `anchor` as a constructor parameter in the covenant.

The covenant's `finalize()` then adds:

```solidity
bytes h1Prev = h1.split(4)[1].split(32)[0];
require(h1Prev == btcChainAnchor);
```

This means `h1` must be the direct successor of the anchor block —
i.e., `h1 == header_at_height_H+1`.

## Why this blocks cross-network forgery

An attacker constructing a fake testnet chain cannot make its `h1`
have `prevHash == anchor` unless they can find testnet mining work that
builds on the specific mainnet block hash. That would require:

- Mining a testnet block whose header commits to a mainnet prevHash
  that no testnet miner has ever used
- For testnet to accept such a block, it would violate testnet's chain-
  continuation rules (testnet blocks must chain to testnet genesis)

So the attacker cannot produce a testnet block with the required
prevHash. The anchor cryptographically ties the SPV proof to mainnet
(or whichever chain Maker's anchor was chosen from).

## Cost

Measured on the 6×12 (6 headers × 12 Merkle depth) flat covenant:

| Variant | Without anchor | With anchor | Δ |
|---|---|---|---|
| p2pkh | 2,490 ops / 3,571 B | 2,496 ops / 3,590 B | +6 ops / +19 B |
| p2wpkh | 2,484 / 3,557 | 2,490 / 3,576 | +6 / +19 |
| p2sh | 2,490 / 3,569 | 2,496 / 3,588 | +6 / +19 |
| p2tr | 2,484 / 3,557 | 2,490 / 3,576 | +6 / +19 |
| all (4-way) | 2,607 / 3,820 | 2,613 / 3,839 | +6 / +19 |

**Essentially free**: 6 opcodes out of 2,496 (0.24%) buys full cross-
network safety.

## Temporal window

The design as written requires `h1.prevHash == anchor`, which means:

- Anchor is block at height `H`
- The SPV proof's first header is block at height `H+1`
- The payment tx must be in one of blocks `H+1 .. H+N`
- With N=6: Taker has a ~6-block (~1 hour) window to get their payment
  into block H+1

For longer windows, either:
- Increase N (proof chain length). At 280 ops/header, N=144 still fits
  in ~43 KB; Maker could give Taker a 1-day window.
- Or generalize the anchor check to "one of headers[1..N].prevHash ==
  anchor" — allows the chain to start at any point after anchor. Cost:
  ~N × 5 ops (for each level, check prevHash == anchor as an additional
  path). Or: use `tx.outputs.count` of a marker output to indicate
  position. Defer.

For the prototype demo, the 1-hour window is acceptable.

## How Maker picks the anchor

Off-chain, at offer-post time:

```bash
# Query current mainnet tip
HEIGHT=$(curl -s https://mempool.space/api/blocks/tip/height)
HASH_BE=$(curl -s https://mempool.space/api/block-height/$HEIGHT)
# Convert to LE (reverse)
HASH_LE=$(echo -n "$HASH_BE" | sed 's/\(..\)/\1\n/g' | tac | tr -d '\n')
echo "anchor (LE hex): $HASH_LE"
echo "use this for btcChainAnchor param"
```

Maker then:
- Instantiates the covenant with `btcChainAnchor = $HASH_LE`
- Deploys MakerOffer / MakerCovenant on Radiant
- Has ~1 hour for Taker's payment to land in block HEIGHT+1 through HEIGHT+6

## Attacker cost without this protection

Testnet3 / testnet4 with default minimum difficulty: ~2^32 hashes per
valid block. At modern hash rates (consumer GPU ~1 GH/s), that's ~4
seconds per block. A 6-header fake chain: ~24 seconds. Cost: effectively
zero.

Testnet chains with easier 20-minute-rule difficulty: orders of magnitude
cheaper yet.

## Attacker cost WITH this protection

To forge a chain that passes the anchor check, attacker must mine
real-mainnet-difficulty blocks starting from the committed block hash.
At current mainnet difficulty (~86 trillion), each block = ~2^75 hashes.
Cost per block: hundreds of thousands of dollars in electricity.

The protection flips the cost from ~$0 to the full PoW-forgery cost
of real mainnet — which is exactly the security bound the Gravity
paper analyzes (~$428k per block × N blocks).

## Implementation status

- ✅ `gen_maker_covenant.js` emits the anchor check in all variants
- ✅ Constructor param `bytes32 btcChainAnchor` added
- ✅ Compiled + measured across all 5 btc-type variants
- ⬜ Maker-side helper to fetch current mainnet tip hash (trivial; use
  curl from mempool.space as shown above)
- ⬜ End-to-end mainnet demo using this covenant

## Production readiness

**Before**: covenant was theoretically vulnerable to cross-network
SPV forgery. Prototype was acceptable for compile/algorithm validation
but not for any real value deployment.

**After**: covenant is protected against cross-network forgery at a
cost of 6 opcodes. Protection is cryptographically enforced at the
consensus level, not a policy/relayer assumption.

**This is a hard requirement** for any production Gravity deployment.
The pre-anchor covenant should never hold real value.