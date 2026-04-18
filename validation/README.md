# Mainnet validation workflow

Scripts to construct real Radiant mainnet transactions that exercise the
compiled covenants. Used to close the gap between "compiles cleanly" and
"actually accepted by consensus."

Currently set up for `verify_header.rxd` (272 ops / 402 bytes, no constructor
args). Other covenants can be added by parameterizing `compute_address.js`.

## Prerequisites

- Node 18+, `npm install` in this directory
- A Radiant wallet with a small amount of photons (a few thousand is enough —
  cost on mainnet is low; each full round-trip costs on the order of
  10k photons in fees)
- Some way to send a funding tx and broadcast a raw tx. Any of:
  - `radiant-cli` via your own node
  - The existing `radiant-mainnet` container on VPS: `sudo docker exec radiant-mainnet radiant-cli ...`
  - A web block explorer that supports `sendrawtransaction`

## Step 1 — Compute the covenant's P2SH address

Every covenant is deployed as a P2SH UTXO. The funding tx pays the P2SH address;
the spend reveals the full 402-byte redeem script and the 80-byte header witness.

```bash
# (re)compile the contract first if needed
node /path/to/RadiantScript/packages/cashc/dist/main/cashc-cli.js \
  ../contracts/verify_header.rxd -o verify_header.artifact.json

# compute the P2SH address
node compute_address.js verify_header.artifact.json
```

Output shows the P2SH address (e.g. `3GMGDqLRJ8qYSGxB53pGDWsAA4vkWsDud2` for
the current `verify_header.rxd` with no constructor args).

## Step 2 — Fund the covenant

Send a small amount of photons to the P2SH address shown in Step 1.

Recommended: 10,000 photons. More than enough to cover the spending tx fee,
with leftover for the destination output.

Record from your funding tx:
- `txid` (64-hex chars)
- `vout` (output index that paid the P2SH)
- `amount` (satoshis in that output)

## Step 3 — Build the spending tx

```bash
node build_spending_tx.js \
  --artifact verify_header.artifact.json \
  --funding-txid <txid from step 2> \
  --funding-vout <vout from step 2> \
  --funding-amount <amount from step 2> \
  --header-hex 00e05f2aab948491071265ad552351d0ad625745668da54b0172010000000000000000004f89a5d73bd4d4887f25981fe81892ccafda10c27f52d6f3dd28183a7c411b03b7072366194203177d9863ea \
  --to-address <your Radiant address to receive the leftover> \
  --fee-sats 6000
```

The `--header-hex` above is Bitcoin block 840000 (post-halving, well-known PoW-valid).
For the covenant to pass, the hash256 of this header must be less than the target
derived from its nBits — which is true for any valid Bitcoin block.

Output: a raw tx hex. Size is ~570 bytes; fee of 6000 photons ≈ 10 sat/B which
satisfies Radiant's min relay fee.

## Step 4 — Broadcast

Any of:

```bash
# Via radiant-cli on your node
radiant-cli sendrawtransaction <rawtx hex>

# Via VPS container
ssh ericadmin@89.117.20.219 \
  'sudo docker exec radiant-mainnet radiant-cli -datadir=/home/radiant/.radiant \
   sendrawtransaction <rawtx hex>'

# Via curl to local node (assuming RPC credentials in .cookie or config)
curl -u user:pass -d '{"method":"sendrawtransaction","params":["<rawtx hex>"]}' \
  http://localhost:7332/
```

## Expected outcomes

**PASS**: tx accepts, returns a txid, eventually confirms. Proves the compiled
bytecode for `verify_header.rxd` executes correctly against a valid Bitcoin
header under Radiant's consensus rules. Major milestone — closes the
"compiler correctness" gate.

**FAIL with `mandatory-script-verify-flag-failed`**: the script evaluated to
false or ran into a script-level error. Investigation needed:
- Is the final stack shape clean? (`SCRIPT_VERIFY_CLEANSTACK` is mandatory)
- Does the algorithm match the reference? Compare ASM to `reference_verify.js`.

**FAIL with `non-mandatory-script-verify-flag`**: similar but indicates a
policy-level rejection. Could be tx size, sig-op count, etc. Check the
specific flag name in the error.

**FAIL with `non-final`**: probably a locktime / sequence issue in how
`build_spending_tx.js` builds the tx. Debug via setting sequence / locktime
fields explicitly.

## After verify_header.rxd passes

Validate the chain: redo steps 1-4 with `verify_chain6.rxd` (1,672 ops).
Requires the spending tx to provide 6 consecutive mainnet header witnesses.

Then Merkle. Then the full Maker covenant. Each step is pure scaling of a
validated foundation.

## Why P2SH and not raw script

Radiant inherits BCH's P2SH soft-fork. Raw non-standard scripts are mineable
but not relayed through the P2P network — they'd require private miner
coordination. P2SH is the standard deployment path and matches what production
Gravity covenants would use.

At Radiant's 32 MB element-size limit, the full 402-byte redeem script reveal
poses no issue.
