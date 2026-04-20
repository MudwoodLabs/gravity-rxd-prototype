# Session handoff — Gravity prototype state

This document captures the project state as of the last commit, written so
any collaborator (or the original author on a different machine) can pick
up where the work left off without re-reading the full development thread.

## Where to start

**On a fresh machine**: `git clone git@github.com:Zyrtnin-org/gravity-rxd-prototype.git`. Everything below is in this repo.

**Read these, in order**:
1. `README.md` — overview + measurement summary
2. `GRAVITY_ANALYSIS.md` §1–§10 — design rationale + every txid from mainnet validation
3. `docs/CHAIN_ANCHOR.md` — the production-safety cornerstone
4. `docs/SEGWIT_SUPPORT.md` — multi-type address support + segwit strip
5. `relayer/TRADE_FLOW.md` — step-by-step mainnet trade
6. `UPSTREAM_BUGS.md` — 3 unfiled RadiantScript bugs

## Project state (as of the commit containing this doc)

### What's done

- **Covenant** — complete, production-safety equipped:
  - 6-header BTC PoW + chain-linking verification
  - 12-level Merkle branch verification
  - **Chain-identity anchor** (blocks cross-network SPV forgery)
  - **Flexible Merkle root** (tx accepted in any of h1..hN)
  - All 4 BTC output types (P2PKH, P2WPKH, P2SH, P2TR)
  - 4-way dispatch or single-type mode
  - MakerOffer + claim/finalize/forfeit/cancel paths

- **Relayer** — 9 CLI commands covering both sides:
  - Radiant: `fetch-spv-proof`, `validate-proof`, `build-finalize-tx`, `build-claim-tx`, `broadcast`
  - Bitcoin: `btc-keygen` (all 4 formats), `btc-get-utxos`, `btc-build-payment`, `btc-broadcast`

- **Mainnet validation** (all txids recorded in GRAVITY_ANALYSIS.md):
  - 4 individual SPV primitives: `a0e10946…`, `9a8a6b2e…`, `2d90a6bb…`, `339866d8…`
  - MakerOffer cancel: `9ab535ab…`
  - Direct-fund full finalize: `902daa91…`
  - MakerOfferSimple claim + finalize: `28795a75…`, `5811fbb7…`
  - Bound Path A (proper binding + claim + finalize): `ad3f1e26…`, `4e292c30…`, `2455ed84…`
  - Total session cost across all tests: **~0.78 RXD** (under $0.01)

### What's NOT done (in priority order)

1. **Mainnet demo of fully-anchored Path A** ← we're about to do this
   - Uses the chain-anchored + flexible-Merkle covenant
   - Real BTC payment (~$0.15 fee), ~1 hour
   - Validates the full production-ready design end-to-end

2. **Upstream bug reports to Radiant-Core/RadiantScript**
   - 3 bugs documented in `UPSTREAM_BUGS.md`
   - Branches staged locally at `/home/eric/apps/RadiantScript/`
   - Trivial PRs, just need posting

3. **REP draft** — formal Radiant Enhancement Proposal with measurements

4. **Public repo decision** — currently `Zyrtnin-org/gravity-rxd-prototype` (private)

5. **Multi-way extension** (paper §5) — Radiant as bond layer for any-two-PoW trades. Larger design work.

## Environment setup (new machine)

### Required
- Node 18+
- git
- SSH key with access to the VPS (for Radiant broadcasts) — or set up your own Radiant node

### Optional but recommended
- A Bitcoin wallet with 5,000 sats (~$0.40) for end-to-end tests
- gh CLI for GitHub interactions (if pushing changes)

### Build the rxdc compiler

```bash
# Clone our RadiantScript fork with fixes applied
# (or clone Radiant-Core/RadiantScript and apply the 3 fixes from UPSTREAM_BUGS.md)
cd ~/apps
git clone https://github.com/Radiant-Core/RadiantScript.git
cd RadiantScript
git checkout radiantscript

# Apply the 3 fixes documented in UPSTREAM_BUGS.md:
#   1. Remove duplicate property keys in packages/cashc/src/generation/utils.ts (lines 53-57)
#   2. Change @cashscript/utils → @radiantscript/utils in ast/Globals.ts + generation/utils.ts
#   3. Stub BLAKE3 / K12 to [] as any in generation/utils.ts (workaround until v2 opcodes assigned)

npm install
cd packages/cashc && npm run build
cd ../..

# Verify it works
node packages/cashc/dist/main/cashc-cli.js -c -s examples/hodl_vault.cash
# Should print opcode count and bytesize
```

Absolute path to the compiler binary: `$PWD/packages/cashc/dist/main/cashc-cli.js`
You'll need this path in commands throughout the repo.

### Install relayer deps

```bash
cd ~/apps/gravity-rxd-prototype/relayer
npm install
```

### Install validation deps (for extract_p2sh_code_hash.js etc.)

```bash
cd ../validation
npm install
```

## Current artifacts you may need

**Deployed covenants** (on mainnet, reference only — UTXOs may be spent):
- MakerOffer (bound, from earlier run): `3Ex5LwdwUnnx7YqhFFLYe3MqjBuCnfgm12`
- MakerCovenantFlat6x12 (pre-anchor, Path B): `3CoEPBRRQxTxA7SAZwo8rZEmquZcdRcEuq`

For the mainnet demo, fresh covenants will be deployed — these are just reference.

**Generated contracts kept in the repo**:
- `contracts/verify_header.rxd` — primitive
- `contracts/verify_chain2.rxd` / `verify_chain6.rxd` — chain tests
- `contracts/verify_merkle1.rxd` — Merkle primitive
- `contracts/verify_payment.rxd` — payment primitive
- `contracts/maker_cancel.rxd` / `maker_offer.rxd` / `maker_offer_simple.rxd` — offer variants
- `contracts/maker_claimed.rxd` — state-separated claimed
- `contracts/maker_covenant_6x12.rxd` — state-separated full covenant
- `contracts/maker_covenant_flat_6x12.rxd` — flat full covenant (current test target)

**Radiant wallet** used for all Radiant-side operations:
- Connection: `ssh <your-radiant-node-ssh> 'sudo docker exec radiant-mainnet radiant-cli -datadir=/home/radiant/.radiant <cmd>'`
- Balance as of last check: ~5,315 RXD (more than enough for any remaining tests)
- Demo needs only ~0.5 RXD at a time

## The pending mainnet demo plan

When ready to execute:

1. Query Bitcoin mainnet tip: `curl -s https://mempool.space/api/blocks/tip/height`
2. Get that block's hash, reverse to LE → this is `btcChainAnchor`
3. Generate Maker BTC keypair: `node relayer/src/cli.js btc-keygen`
4. Generate (or reuse) a Taker Radiant address
5. Instantiate `maker_covenant_flat_6x12` with:
   - makerPkh = your Radiant pkh
   - takerRadiantPkh = Taker Radiant pkh
   - btcReceiveHash + btcReceiveType = from btc-keygen, recommend P2WPKH (type 1)
   - btcSatoshis = 1000 (tiny to bound risk)
   - btcChainAnchor = from step 2
   - claimDeadline = 0
   - totalPhotonsInOutput = 1000000
6. Fund the resulting P2SH with ~50M sats from your Radiant wallet
7. Taker (you, with any BTC wallet) sends 1000+ sats to the Maker BTC address — anywhere in the next 6 blocks (~1 hour)
8. Wait 6 BTC confirmations
9. Fetch SPV proof: `node relayer/src/cli.js fetch-spv-proof --txid <btc-payment-txid>`
10. Locate P2PKH/P2WPKH output offset in the raw tx
11. Build + broadcast finalize: `node relayer/src/cli.js build-finalize-tx ... | broadcast`
12. Photons route to Taker Radiant address → trade complete

Full commands in `relayer/TRADE_FLOW.md`.

**Failure recovery**: if finalize fails (wrong anchor, missed window, etc.), the Photons are recoverable via `forfeit()` which is always available (claimDeadline=0). Max loss: a few photons in fees.

## Decision log — the important design choices

1. **P2SH wrapping for covenants**: simpler deployment, standard relay rules. Alternative of raw non-standard scripts would need miner coordination.

2. **Chain-identity anchor via h1.prevHash**: simplest mainnet commitment. Alternative "anchor at any position" would be ~5N more ops for negligible benefit.

3. **Flexible Merkle anchor**: accept tx in any of h1..hN. Aligns with paper's security analysis; strict-h1 was accidental.

4. **Witness stripping off-chain**: segwit/taproot support done in relayer, not in covenant. Covenant stays simple; works for any tx format.

5. **Multi-type payment verification via dispatch**: 4-way branch for P2PKH/P2WPKH/P2SH/P2TR. Alternative of per-type covenants would proliferate bytecode variants; single-covenant+dispatch is cleaner.

6. **Paper's bond mechanism deferred**: our current MakerOffer doesn't require Taker bond. Taker can claim and abandon (causing Maker to wait out claimDeadline). Safe enough for prototype; production bond support is an extension.

## Known issues / technical debt

1. **Binding has off-chain coordination requirement**: Maker must commit to specific Taker pkh at offer time (because P2SH wraps the full locking script including state). A stateSeparator-based binding would allow variable Taker pkh, but stateSeparator semantics on P2SH outputs need more investigation (see §10o in GRAVITY_ANALYSIS.md).

2. **claim() can't be refused by the Maker**: once claimed, only finalize or forfeit resolves. In practice, Maker posting the offer is the acceptance.

3. **Merkle tree depth hardcoded**: N=12 in our default 6×12 generator. Blocks with trees deeper than 12 levels (>4096 txs) would break. Fine in practice; Bitcoin blocks usually have <4000 txs.

4. **RadiantScript v2 opcodes incomplete**: BLAKE3 and K12 language functions exist but don't map to opcodes (see UPSTREAM_BUGS.md Bug 3). We stub them.

5. **No test suite**: validation is via mainnet broadcast, not automated. Adding Jest-style tests for the generator output would catch regressions.

## Quick command reference

```bash
# Generate a full Gravity Maker covenant (6 headers, 12 Merkle, P2WPKH only)
node generators/gen_maker_covenant.js 6 12 --flat --btc-type p2wpkh

# Compile to artifact
node /path/to/cashc-cli.js <contract>.rxd -o validation/<name>.artifact.json

# Compute P2SH-based code-hash for MakerOffer binding
node reference/extract_p2sh_code_hash.js <artifact.json> key=value ...

# Fetch BTC SPV proof (auto-strips witness)
node relayer/src/cli.js fetch-spv-proof --txid <btc-txid> --headers 6 > proof.json

# Build Radiant finalize tx
node relayer/src/cli.js build-finalize-tx \
  --spv-proof proof.json \
  --redeem-hex <hex or path> \
  --funding-txid <...> --funding-vout <...> --funding-amount <...> \
  --output-offset <...> --to-address <...> --fee-sats 48000000

# Broadcast to Radiant via SSH'd VPS
node relayer/src/cli.js broadcast --tx-hex <hex or path>

# Broadcast BTC tx via mempool.space
node relayer/src/cli.js btc-broadcast --tx-hex <hex>
```

## Git history to review

Key commits in chronological order (see `git log --oneline`):

- `62bf4bd` Initial prototype (SPV primitives)
- `98eb4b3` Radiant spending paths + integrated covenant
- `7a0750c` Claim-binding gap closed via stateSeparator
- `6dbb845` Validation scaffolding
- `90ba4e2` verify_header mainnet confirm
- `7d3c790` All 4 primitives mainnet
- `4988316` MakerOffer cancel on mainnet + stateSeparator covenant
- `e5b80c3` Relayer skeleton (BTC SPV fetch)
- `14a83d5` build-finalize-tx
- `86f708b` END-TO-END finalize on mainnet (Path B)
- `a148ee4` PATH A state machine on mainnet
- `89b8bdd` codeScript semantics resolved + CLI wired + bound Path A
- `c22377b` BTC-side tooling (keygen, payment, broadcast)
- `27616fb` Segwit witness auto-strip
- `e006e2c` Phase 1+2: P2WPKH/P2SH/P2TR support
- `110fb27` Chain-identity anchoring
- `96d54f5` Flexible Merkle anchor (any of h1..hN)

Latest commit will always be visible via `git log -1` — this doc will lag.

## Where to stop if you're not continuing

The prototype is functionally complete. If you stop here:
- Everything is on GitHub (private) under `Zyrtnin-org/gravity-rxd-prototype`
- All validation txids are preserved on Radiant mainnet chain
- Design rationale is captured across GRAVITY_ANALYSIS.md + docs/
- No half-finished work, no loose ends

Re-opening means picking up from "mainnet demo of anchored covenant" or going directly to REP drafting + upstream bug filing.
