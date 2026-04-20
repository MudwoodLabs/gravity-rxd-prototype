# Audit 04 — Atomic-swap economic security

Focus: game-theoretic and state-machine security. Griefing vectors,
fee-sniping, binding, recovery paths, off-chain trust. Covenant opcodes,
Bitcoin-side crypto, and secrets/deps are in separate reports.

> **Update — Phase 4 + 5 remediation status (2026-04-19).** This report
> records the audit findings as they were at the original audit pass
> (commit `d984701`). Several findings below have since been addressed,
> partially addressed, or re-framed. **Current status of each finding:**
>
> | # | Current status |
> |---|----------------|
> | S1 `claimDeadline` race | Mitigated at the tooling level only. See [`docs/S1_TIME_MODEL_LIMITATION.md`](../S1_TIME_MODEL_LIMITATION.md) for the full architectural explanation. Short version: RadiantScript has no "now" primitive at claim time, so the covenant cannot dynamically enforce "claimDeadline is in the future." The generator bakes a 30d-rear floor, the client-side deploy tool refuses `claimDeadline < now + 24h`, and the Taker is instructed to independently re-verify. Honest tooling + Taker re-verification closes the race; adversarial Maker + un-verifying Taker is still vulnerable. |
> | S3 claim() permissionless | **CLOSED** — `contracts/maker_offer.rxd` now requires `checkSig(takerSig, takerPk)` before state transition. |
> | S4 single-Taker binding | Unchanged; architectural. |
> | S5 reorg safety at N=6 | Unchanged. |
> | S7 anchor-window asymmetry | Partially mitigated — relayer pre-flight refuses out-of-window txs (`fetch-spv-proof --anchor-height`). |
> | S8 off-chain param binding | Unchanged; no `verify-offer` command exists. Taker must still manually re-run `extract_p2sh_code_hash.js`. |
> | Phase-3 structural constraint Taker grief (legacy/multi-input) | Mitigated — in-repo `btc-build-payment` rejects non-segwit and multi-input; docs (`SEGWIT_SUPPORT.md`, `TRADE_FLOW.md`) updated to warn external-wallet Takers. |
>
> See [`2026-04-19-README.md`](./2026-04-19-README.md) for the consolidated
> view and the commit log (Phases 1-5) for remediation detail.

---

## S1 — SHOW-STOPPER: `claimDeadline = 0` → finalize/forfeit race from block 1
**Status: VULNERABLE (critical for value-bearing trades; survived in
practice only because Maker and Taker were cooperative)**

- `TRADE_FLOW.md` step 3 shows `claimDeadline=0` as the recommended value.
- `relayer/src/forfeit_tx.js:10-11, 50-51` comments: "For claimDeadline=0,
  the time check is trivially satisfied."
- `contracts/maker_covenant_flat_6x12.rxd:399`:
  `require(tx.time >= claimDeadline);` — with `claimDeadline = 0`, this is
  always true.
- `GRAVITY_ANALYSIS.md:1593`: describes the behavior as a cleanup
  convenience, not flagged as a protocol defect.

**Consequence:** the instant a MakerClaimed UTXO exists, both `finalize()`
and `forfeit()` are simultaneously spendable. Whoever broadcasts first
wins. A malicious Maker monitors mempool; the moment Taker's BTC confirms,
Maker rushes `forfeit()` to reclaim RXD. If Maker's forfeit lands first,
Taker has paid BTC for nothing. `forfeit()` needs no signature — any third
party can trigger it.

**This is the single biggest game-theoretic defect in the deployed
prototype.** The real mainnet trade "worked" because Maker and Taker were
cooperating (same operator testing the flow). A real counter-party would
be systematically exposed.

**Required fix:** `claimDeadline` must be set to a Radiant block height or
Unix time sufficiently in the future (≥ 24 hours recommended). The
`forfeit()` path must reject spends before that. Relayer + demo scripts
should default accordingly.

---

## S2 — SHOW-STOPPER: Flexible Merkle anchor reduces PoW barrier to 1 block for in-h1 txs
**Status: VULNERABLE (severity scales with trade value)**

- `docs/CHAIN_ANCHOR.md:74-91`: anchor at height H; SPV proof's h1 is
  block H+1; tx must be in one of h1..hN.
- `generators/gen_maker_covenant.js:86-119`: only `h1.prevHash ==
  btcChainAnchor` is enforced; Merkle match accepted against ANY of
  h1..hN.

An attacker who mines h1 (one real-mainnet-difficulty block) controls its
merkleRoot; h2..hN don't further fence h1 because the check is an OR. But
they still need real PoW on h2..hN because the covenant enforces PoW
per-header. So attacker cost is "N blocks of mainnet PoW" — same as the
paper's bound.

However: the 1-hour anchor window (CHAIN_ANCHOR.md:91) forces re-anchoring
and pushes Makers toward short N. Until N is configurable at offer time
to trade-value-appropriate levels, **large trades are under-protected**.

Guidance: Maker must choose N such that `N × cost_per_block_of_PoW >
value_of_trade + safety_margin`. For N=6 and ~$428k per block, that's
~$2.5M safety. A $2.5M+ trade with N=6 is inadequate.

---

## S3 — HIGH: `MakerOffer.claim()` is permissionless — griefing vector
**Status: PARTIALLY MITIGATED (attacker can't steal, but can grief)**

- `contracts/maker_offer.rxd:44-48`: claim() has no signature check. Only
  constraint is `tx.outputs[0]` is a P2SH whose hash matches
  `expectedClaimedCodeHash`.

Combined with P2SH binding (commits to specific Taker pkh):
- GOOD: random attacker can't claim with their own pkh.
- BAD: any party can be the signer of the claim tx. A Taker who changes
  their mind, or a neutral third party, can advance state by broadcasting
  `claim()`.
- With `claimDeadline=0`: griefer claims, immediately forfeits, Maker
  pays two Radiant fees to end up with own RXD back.

**Required fix:** `claim()` should require a Taker signature (~6 opcodes).

---

## S4 — HIGH: Binding to SPECIFIC Taker pkh at offer time — no order book
**Status: VULNERABLE by design (architectural, not a bug)**

- `GRAVITY_ANALYSIS.md:1526-1530`: "Maker must commit at offer time to the
  Taker's specific Radiant pkh... Real trades where Taker identity varies
  need either (a) off-chain matching or (b) alternative binding (future
  work)."

Implications:
- Griefing by third-party claimants with own pkh: **SAFE** (binding
  prevents it).
- If Taker's wallet rotates or they switch devices and lose privkey: offer
  is dead. Maker cancels. No funds lost, but time/fees wasted.
- **No order book:** Gravity as designed is strictly bilateral. Limits
  market-making.

Required for future: stateSeparator-based design where Taker pkh is in
state section (mutable) and codeScript is Taker-invariant
(`GRAVITY_ANALYSIS.md:846-848`).

---

## S5 — HIGH: Chain-reorg safety inadequate for large trades
**Status: VULNERABLE**

- Covenant accepts proof once N headers validate. No minimum confirmation
  depth beyond N. `TRADE_FLOW.md:152-156` instructs Taker to "Wait for 6
  BTC confirmations" — a relayer convention, not a covenant check.

Attack: Taker's BTC payment confirms at H+1. Taker builds proof over
H+1..H+6. Submits finalize on Radiant. Bitcoin reorgs > 6 blocks deep
(rare but historically observed on smaller chains). Taker's BTC tx gets
orphaned. Taker got RXD AND still has BTC — Maker's loss.

For large trade, Maker should demand N >> 6 (paper suggests 144). Covenant
has no post-finalize cool-down on Radiant either.

**Required for production:** trade-size-appropriate N. `CHAIN_ANCHOR.md`
shows N=144 feasible (~43 KB script). Current README validates at N=6 —
**inadequate for large trades**.

---

## S6 — MEDIUM: Fee-starvation → Maker's RXD stuck for full `claimDeadline`
**Status: VULNERABLE (ack'd in design notes)**

Taker's BTC payment has too-low fee, gets stuck. Can't RBF (would change
txid; covenant expects specific txid). Options:
- Wait for mempool drop (14 days default).
- CPFP via change output if kept.
- Resubmit with higher fee on different input (covenant accepts whichever
  tx confirms within anchor window).

Maker's RXD locked until `claimDeadline`. With `claimDeadline=0` (S1),
griefing attack: Taker claims, never pays BTC, Maker forfeits immediately
— but has paid two Radiant fees.

---

## S7 — MEDIUM: Anchor window + claimDeadline=0 asymmetry
**Status: VULNERABLE (interaction of S1 + S2)**

N=6 gives ~1-hour window for Taker to get payment into h1..hN. After
that, covenant cannot be finalized. With `claimDeadline=0`, forfeit is
always open. Net:
- Late BTC → Maker wins (keeps BTC), Taker loses (no RXD, no refund).
- No BTC-side refund mechanism — Taker relies on Maker goodwill.

**Maker-favorable asymmetry.** `GRAVITY_ANALYSIS.md:1572` describes exactly
this mistake in the documented trade (covenant had to be re-deployed).

Guidance: Takers should never send BTC when < 2 blocks remain in anchor
window.

---

## S8 — MEDIUM: Off-chain parameter communication has zero cryptographic binding
**Status: VULNERABLE (Taker must independently verify P2SH reconstruction)**

- `TRADE_FLOW.md:60-67`: Maker computes P2SH from params; Taker is given
  P2SH address + param list out-of-band.

Social attack: Maker announces "100M sats RXD for 171,000 BTC sats" but
secretly uses `totalPhotonsInOutput=50000000`. Taker sends BTC. Covenant
pays Taker 50M, Maker pockets difference.

Mitigation: Taker can reconstruct P2SH from params. Not documented as a
required step. Relayer has no `verify-offer` command.

**Required:** Taker-side verification tool (~20 lines).

---

## S9 — LOW-MEDIUM: Bitcoin contentious-fork exposure
**Status: UNKNOWN**

`CHAIN_ANCHOR.md` protects against cross-NETWORK (testnet vs mainnet). Not
against same-network fork. If BTC forks after Maker's anchor:
1. Attacker pays on LOSING fork (still real PoW at time).
2. Presents that proof to covenant → accepted.
3. Attacker keeps BTC on winning fork.

Rare event; document as operational caution.

---

## S10 — LOW: Fee-sniping / finalize() race
**Status: SAFE (unintuitively)**

finalize() is permissionless but routes output[0] to fixed
`takerRadiantPkh`. A third party has no incentive — they'd be paying
Taker's fees.

Edge case: third party finalizes with higher fee, reducing Taker's payout.
If Maker sets `totalPhotonsInOutput = fundingAmount - max_fee`, attacker
can increase fee only up to that ceiling. Loose setting loses Taker
margin.

**Guidance:** Maker should set `totalPhotonsInOutput` tightly.

---

## S11 — LOW: Fake-offer DoS against Takers
**Status: PARTIALLY MITIGATED**

Taker should verify offer params match P2SH BEFORE doing SPV work. If they
don't verify (S8), they pay BTC to an address not mapped to a real
covenant — but then no covenant exists to finalize against. Standard scam
risk.

---

## S12 — INFORMATIONAL: forfeit() permissionless beyond timelock
**Status: SAFE (acceptable by design)**

`maker_claimed.rxd:52-57` requires only `tx.time >= claimDeadline`;
routes output[0] to Maker's pkh. Permissionless — anyone can trigger, but
funds always go to Maker. Economically neutral.

**Edge case:** if Maker loses Radiant key, `makerPkh` is dead. RXD
permanently burned.

---

## Game-theoretic summary

### When is this safe to use, for a trade of size $X?

- **X < ~$10:** safe demonstration. PoW-forgery cost (~$2.5M for N=6)
  vastly exceeds trade value. Main risk: UX (S7 timing).
- **$10 < X < ~$100k:** probably safe if S1 fixed (claimDeadline > anchor
  window + proof-gen time, e.g. 24h). Without S1 fix, Maker can grief
  Taker for arbitrary X. Requires S8 (Taker-side param verification).
- **$100k < X < ~$1M:** N=6 inadequate. Move to N=72+. Requires S1, S5,
  S8 fixes.
- **X > ~$1M:** not ready. Reorg safety + forgery margin need N=144+ and
  deeper Radiant confirmation buffers. Single-Taker binding (S4) =
  OTC-only.

### Maker should decline to participate when:
- Any offer with `claimDeadline=0`.
- Trade value × Maker's hourly opportunity cost > expected fee income
  (fee-starvation DoS).
- Offer parameters conflict with pending BTC fork events.

### Taker should decline to participate when:
- Anchor window ≤ 2 blocks remaining.
- Taker's Radiant pkh not baked into covenant (S4).
- Cannot independently verify P2SH parameter reconstruction (S8).
- Reorg-sensitive trade where value approaches PoW-forgery cost for the N.

### Show-stoppers for production
1. **S1** — `claimDeadline=0` default. Fix before any multi-party use.
2. **S5** — reorg safety; current N=6 inadequate for non-trivial trades.
3. **S3** — `claim()` permissionless/unsigned permits grief-level state
   advances.

---

## Conclusion

The Gravity prototype has successfully validated the SPV-covenant
primitives on mainnet. But the **economic/state-machine surface** around
those primitives is **not production-safe for trusted counter-parties,
let alone adversarial ones**.

The real mainnet trade (`cda28ca2…7b28`) succeeded because Maker and
Taker were cooperating. Adversarially, `claimDeadline=0` alone would have
let either side grief. Combined with single-Taker-binding (S4) and anchor-
window asymmetry (S7), this protocol currently only works for
**bilaterally-trusting OTC counter-parties who already trust each other
enough to cooperate on re-deployment if anything goes wrong**.

Core cryptographic construction (SPV-witnessed covenant with chain-
identity anchor) is sound. Economic glue (deadlines, permissions,
binding, racing) is not yet production-grade. **Fixing S1 alone** plus
**requiring Taker signature on `claim()`** (S3) would move this from
"cooperative-only" to "defensibly adversarial for small trades." Large
trades additionally need S5 (larger N) and S4 (better binding).
