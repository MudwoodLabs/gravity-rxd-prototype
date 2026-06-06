# gravity-rxd-prototype

> ⚠️ **Research prototype — do not hold value in this covenant.**
>
> A 2026-04-19 internal security review (see [`docs/audits/`](./docs/audits/))
> found multiple paths to drain any Maker UTXO. Phases 1-6 of remediation
> (see commit history) have closed every original show-stopper, but one
> architectural limit remains: the finalize/forfeit race (audit 04 S1)
> can only be mitigated at the tooling level because RadiantScript has no
> "now" primitive — see [`docs/S1_TIME_MODEL_LIMITATION.md`](./docs/S1_TIME_MODEL_LIMITATION.md).
> Safe for cooperative-OTC trades with independent Taker-side
> verification; not safe for adversarial public deployment as-is.

> 🧭 **Superseded for *swaps* — the deadline race was solved by switching to an
> HTLC.** The finalize/forfeit race above (audit 04 S1) is *fundamental* to the
> SPV-oracle **swap** design, not a tooling bug: the Taker's BTC payment is
> irreversible, but the covenant cannot bind an upper-bound deadline on it
> (RadiantScript's only time primitive, `tx.time`/CLTV, is a `>=` lower bound).
> The fix is not deadline tuning — it is a different construction. A **hashlock +
> relative-timelock (HTLC) atomic swap** binds both legs to one secret
> `H = sha256(p)` (Radiant's `OP_SHA256` is Bitcoin-compatible, so no adaptor
> signatures are needed for v1) and gives each side an `OP_CHECKSEQUENCEVERIFY`
> refund path. The worst case becomes "both sides refund and walk away whole" —
> never the one-sided loss S1 describes. See
> [`docs/SPV_SWAP_SUPERSEDED_BY_HTLC.md`](./docs/SPV_SWAP_SUPERSEDED_BY_HTLC.md).
>
> **The SPV *primitives* in this repo are NOT deprecated.** Header-PoW,
> Merkle-branch, and payment verification still answer a question an HTLC cannot:
> *prove a Bitcoin fact to Radiant with no Bitcoin-side counterparty and no
> Bitcoin-side script* — bridge-in / mint-against-deposit, gated release,
> proof-of-payment. What the HTLC supersedes is the SPV-oracle **swap covenant**
> (finalize/forfeit), which it strictly dominates; the verification machinery
> below is retained and still sound.

A working-code prototype of the [Gravity protocol](https://github.com/Radiant-Core/Project-Gravity) — peer-to-peer cross-chain exchange using SPV proofs and covenants on the [Radiant blockchain](https://www.radiantcore.org/).

This repository contains RadiantScript contracts, code generators, and Node.js reference implementations for the core SPV verification primitives needed to implement pure-SPV Gravity without requiring any new Radiant consensus opcodes.

## Status

**Primitive-level engineering complete. First mainnet validation confirmed.**

Every component needed for the bilateral Maker covenant has been written, compiled, measured, and algorithmically validated against real Bitcoin mainnet data. One component (`verify_header.rxd`) has additionally been validated on Radiant mainnet — the compiled bytecode executes correctly under live consensus.

| Component | Ops | Bytes | Validation |
|---|---|---|---|
| **Single-header PoW verify** | **272** | **402** | ✅ block 840000 + mainnet `a0e10946…7409` (confirmed) |
| **2-header chain verify** | **552** | **815** | ✅ blocks 840000→840001 + mainnet `9a8a6b2e…32173` |
| 6-header chain verify | 1,672 | 2,479 | compile + reference |
| **Single-level Merkle** | **32** | **38** | ✅ synthetic tree + mainnet `2d90a6bb…8127` |
| Depth-12 Merkle branch | 763 | 924 | compile + reference |
| **BTC P2PKH payment verify** | **25** | **60** | ✅ synthetic tx + mainnet `339866d8…819c` |
| Full Maker covenant 6×12 (w/ stateSeparator) | 2,501 | 3,571 | compile + code-hash verified |
| **Full Maker covenant 6×12 (flat)** | **2,490** | **3,570** | **✅ finalize() on mainnet `902daa91…48cf8` (Path B) + `5811fbb7…a8a9` (Path A)** |
| MakerOffer with binding | 14 | 90 | ✅ cancel() on mainnet `9ab535ab…f778` |
| **MakerOfferSimple** (weak binding) | **11** | **53** | **✅ claim() on mainnet `28795a75…6ce3` (Path A state machine)** |
| **MakerOffer with P2SH binding** | **14** | **90** | **✅ claim() on mainnet `4e292c30…d679` + finalize() `2455ed84…c9bb` (full bound Path A)** |
| **Production covenant (anchored, P2WPKH, M=13)** | **~2,720** | **~3,820** | **✅ REAL BTC→RXD trade via Venmo: BTC `9432d6a4…3398` → Radiant `cda28ca2…7b28` (2026-04-19)** |
| Phase-10 hardened covenant (dual nBits, Taker sig, structural tx-parse, P2SH-P2WPKH, flexible Merkle, 24h claimDeadline floor) | ~2,848 | ~3,987 | ⚠️ End-to-end self-trade 2026-04-20 (MakerOffer `24b72606…dc45` → finalize `557c443c…fec60`). Subsequently found to have R1 (chunked-compare sign-flip) — covenant accepted `require(x<0)` with attacker-controlled bytes. See probe tx `8b83d0dc…38fd` for on-chain proof. Do not redeploy this build. |
| **Phase-12 post-R1 patched covenant (int(...+0x00) forced-unsigned chunked compare)** | **~2,920** | **~4,275** | **✅ Clean mainnet trade 2026-04-20: MakerOffer `2ed95f32…7729` → claim `5caeb40a…8a95` → BTC payment `08cbbbaf…9f0a` (h2=block 945954) → finalize `db4bd555…33bd` (13M photons to Taker). Sign-flip defense verified by rejected probe `35ea9c8f…7ca2` with same malicious input the Phase-10 covenant accepted.** |

Full Gravity covenant fits in **~3.8 KB of locking script**, about **0.01%** of Radiant's 32 MB script limit.

See [`GRAVITY_ANALYSIS.md`](./GRAVITY_ANALYSIS.md) for the complete analysis, measurements, and design rationale.
See [`validation/README.md`](./validation/README.md) for how to run additional mainnet validations.

## Not yet done

- Radiant-side spending paths (cancel/forfeit/bond accounting) — standard CashScript patterns
- Integration into a single Maker covenant contract
- Bytecode-level validation via testnet broadcast or `rxdeb`
- Relayer TypeScript implementation (off-chain SPV proof construction)
- Multiway extension (Radiant-as-bond per paper §5)
- REP draft with final measurements

## Repository layout

```
contracts/            RadiantScript (.rxd) source files
  verify_header.rxd   Single Bitcoin header PoW verification
  verify_chain2.rxd   2-header chain (hand-written reference)
  verify_chain6.rxd   6-header chain (paper-recommended minimum)
  verify_merkle1.rxd  Single-level Merkle branch
  maker_offer.rxd     Maker-side offer covenant (with Taker sig, v2)
  maker_cancel.rxd    Maker cancel primitive
  verify_header.asm   Compiled ASM of verify_header.rxd
  probes/             Primitive-probe contracts used during exploration
  legacy/             Stale / pre-hardening contracts — DO NOT DEPLOY

generators/           Code generators for parameterized N
  gen_chain.js        Emits verify_chainN.rxd
  gen_merkle.js       Emits verify_merkleN.rxd

reference/            Node.js reference implementations
  reference_verify.js   Single-header PoW algorithm + block-840000 test
  reference_chain.js    N-header chain + consecutive-block validation
  reference_payment.js  P2PKH payment + synthetic-tx test
  reference_merkle.js   Merkle branch + 4-leaf tree test
```

## Building & running

### Prerequisites

- Node.js 18+ (for reference implementations)
- `rxdc` compiler from [Radiant-Core/RadiantScript](https://github.com/Radiant-Core/RadiantScript) built from source. See [UPSTREAM_BUGS.md](./UPSTREAM_BUGS.md) for three build-blocking fixes required.

### Compile a contract

```bash
# From RadiantScript clone:
node packages/cashc/dist/main/cashc-cli.js -c -s \
  /path/to/gravity-rxd-prototype/contracts/verify_header.rxd
```

Prints opcode count and bytesize.

```bash
# ASM output:
node packages/cashc/dist/main/cashc-cli.js -A \
  /path/to/gravity-rxd-prototype/contracts/verify_header.rxd
```

### Generate parameterized contracts

```bash
# 6-header chain verifier
node generators/gen_chain.js 6 > contracts/verify_chain6.rxd

# Depth-12 Merkle verifier
node generators/gen_merkle.js 12 > contracts/verify_merkle12.rxd
```

### Run reference validators

```bash
node reference/reference_verify.js   # single header vs block 840000
node reference/reference_chain.js    # 2-header chain vs 840000→840001
node reference/reference_merkle.js   # Merkle tree with synthetic 4 leaves
node reference/reference_payment.js  # P2PKH output with synthetic tx
```

All scripts exit 0 on pass, non-zero on sanity failure.

## Design notes

### Off-chain-constrained parsing

The BTC payment verifier (25 ops) is tiny because the Taker/relayer pre-computes the output offset within the raw Bitcoin transaction and passes it as an unlocking argument. The covenant just verifies "at this exact offset, there is a P2PKH output to the Maker's pkh with value ≥ required." No varint decoding on-chain.

A wrong offset is rejected by the prefix check (`0x1976a914`).

### Byte-level direction flags for Merkle branches

RadiantScript's compiler disables `>>` bitwise right-shift (verified via probe). Instead of a bit-packed flags integer, each Merkle level encodes direction explicitly: `[1-byte dir][32-byte sibling]`. Taker constructs the flat branch buffer off-chain from Bitcoin's standard Merkle proof format.

### 4-byte chunked unsigned comparison

RadiantScript numbers are 8-byte signed `int64`. Comparing two 32-byte values as unsigned big-endian 256-bit integers requires splitting into chunks that always fit positive in `int64`. 4-byte chunks always do (max `0xFFFFFFFF < 2^63`). 8 chunks × 4 bytes = 32 bytes, compared MSB-first with short-circuit `||` chain.

### Replay prevention

The Maker generates a fresh `expectedPkh` per covenant instance. Each Gravity covenant has a unique pkh; old payments to Maker's other addresses can't unlock new covenants because they didn't pay to this specific one.

## Relation to Project-Gravity

This is an independent prototype, not a fork of [Radiant-Core/Project-Gravity](https://github.com/Radiant-Core/Project-Gravity). The goal is to demonstrate that the paper's pure-SPV design is implementable with Radiant's current instruction set (no consensus changes) and to provide measured data for a future Radiant Enhancement Proposal (REP).

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. Current priorities:
1. Radiant-side spending paths (cancel/forfeit/bond)
2. Single-contract assembly of the full Maker covenant
3. Testnet validation
4. Relayer reference implementation

Please read [GRAVITY_ANALYSIS.md](./GRAVITY_ANALYSIS.md) first for context.
