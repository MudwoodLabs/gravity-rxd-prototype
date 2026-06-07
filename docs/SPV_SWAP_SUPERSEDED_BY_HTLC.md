# The SPV-oracle swap is superseded by an HTLC

**Status:** design decision. The SPV-oracle **swap covenant** (the
finalize/forfeit Maker covenant in this repo) is superseded for cross-chain
**swaps** by a hashlock + relative-timelock (HTLC) construction. The SPV
**verification primitives** (header-PoW, Merkle branch, payment verification)
are **retained** — see [§5](#5-what-is-retained-vs-superseded).

This note explains *why* the swap design changed, what the HTLC fixes that no
amount of covenant hardening could, and the one load-bearing constraint an HTLC
introduces. It is design rationale, not a builder's guide; the HTLC contracts
themselves live in follow-on work and any real-value use is gated on an external
audit.

---

## 1. The SPV-oracle swap is *payment-verified*, not *atomic*

The Maker covenant verifies, on Radiant, that a Bitcoin payment happened — via
an SPV proof (anchored headers + PoW + a Merkle branch + a payment-output
check). That is a genuine, useful fact. But it is **a one-directional oracle,
not an atomic binding**, and the asymmetry is fatal for a swap:

- The Taker's BTC payment is **irreversible** the moment it confirms. There is
  no Bitcoin-side script and no Bitcoin-side counterparty obligation — the BTC
  just goes to an address.
- The Taker then has to *finalize* on Radiant (submit the SPV proof) before the
  Maker's **forfeit** path opens. If the Taker is late — slow proof
  construction, a Radiant reorg, mempool congestion, or a Maker who set the
  deadline aggressively — the Maker can race-broadcast a forfeit and reclaim the
  asset.
- Result: **the Taker can lose the BTC *and* get no asset.** A one-sided loss.
  That is exactly audit finding **S1**
  ([`S1_TIME_MODEL_LIMITATION.md`](./S1_TIME_MODEL_LIMITATION.md)).

The irreversibility is on the **Bitcoin** side, where the Radiant covenant has
no authority. So no Radiant-side change can give the Taker recourse.

### Why it cannot be fixed in the covenant

Two impossibilities, both confirmed against Radiant Core / RadiantScript:

1. **No in-script upper-bound deadline.** RadiantScript's only time primitive is
   `tx.time`, which compiles to `OP_CHECKLOCKTIMEVERIFY` (CLTV) — a `>=`
   consensus *lower* bound on the spending tx. You can require "not before T";
   you cannot require "the Taker must finalize *before* T or the Maker is
   blocked." So a Maker who picks a `claimDeadline` in the past has `forfeit()`
   open immediately. (See `S1_TIME_MODEL_LIMITATION.md` for the opcode-level
   detail.)
2. **The obvious non-fixes don't hold.**
   - *Maker-signature-gated forfeit* (require the Maker to co-sign a forfeit)
     removes the permissionless liveness backstop and introduces a permanent
     stranding / extortion lever — a Maker who vanishes (or demands a ransom)
     freezes the asset forever.
   - *Bonds* don't price correctly: a Maker can always post a bond below the
     subjective value of a unique asset, so griefing stays profitable.

Hardening the parser, tightening the deadline floor, adding client-side checks —
all of these *mitigate* S1 for cooperative trades (which is why this prototype
is "safe for cooperative OTC with independent Taker verification"). None of them
*close* it for an adversarial counterparty. The race is structural to the
"verify a payment that already, irreversibly happened" model.

---

## 2. Why an HTLC fixes it

An HTLC stops treating the BTC leg as a fact to be verified after the fact, and
instead makes **both legs conditional on revealing one secret**:

- Pick a secret `p`; publish `H = sha256(p)`.
- The BTC is locked in a **script-controlled output** (a Taproot tapscript or
  P2(W)SH) with two spend paths: **claim-with-preimage** (anyone presenting `p`)
  and **refund-after-timeout** (the funder, after a relative timelock).
- The Radiant asset is locked the same way: claim-with-preimage / refund-after-
  timeout.
- Claiming either leg **reveals `p` on-chain**, which lets the counterparty
  claim the other leg with the same preimage. If either side stalls, the other
  refunds after its timelock.

So the worst case is **"both legs time out, both parties refund, everyone walks
away whole."** There is no path to a one-sided loss — which is precisely the S1
hole.

Radiant's `OP_SHA256` is Bitcoin-compatible, so a **plain SHA-256 hashlock works
on both chains** — no adaptor signatures are required for a v1. (Adaptor
signatures are a privacy/scriptless optimization, not a correctness
requirement.) Crucially, an HTLC needs **no SPV proof and no on-chain BTC-tx
parser** — the Bitcoin script enforces the condition directly. That removes the
single largest attack surface of the SPV-oracle design (see
[§5](#5-what-is-retained-vs-superseded)).

The cost of the fix is a **retained-state obligation**: the refunding party (or
a watchtower acting for them) must keep the refund key + script and broadcast the
refund if the happy path stalls. That is operational cost, not a UX or safety
regression.

---

## 3. The one load-bearing constraint: timelock ordering

An HTLC is only safe if the two refund timelocks are staggered correctly — the
classic Herlihy result (*Atomic Cross-Chain Swaps*, PODC 2018). For a BTC↔RXD
swap the safe, incentive-aligned role assignment is fixed (treat it as a hard
invariant, not an implementer's choice):

- The **Maker** holds the asset and generates the secret `p` (publishing
  `H = sha256(p)`); the **Taker** holds BTC.
- The **Taker locks BTC first**; the **Maker locks the asset second**.
- The **Maker claims the BTC first**, revealing `p` in the Bitcoin witness; the
  **Taker scrapes `p` from Bitcoin and claims the Radiant asset second**.

The invariant that keeps this safe:

```
Bitcoin refund timeout  >  Radiant refund timeout  +  margin
```

The leg claimed **second** (the Radiant asset) must have the **shorter** refund
window; equivalently the first-claimed leg (BTC) holds the **longer** refund —
which also suits BTC being the slower, harder-to-reorg chain. The margin must
cover reorg depth + relay + congestion. Get the ordering backwards and the
party acting second can be sniped exactly as in the SPV-oracle race — so the
HTLC does not remove the need to reason about timing, it *relocates* it into a
single, checkable inequality.

Two practical rules:

- **The gap is additive (`≥ Δ`), not multiplicative.** You need one safety
  window Δ between the legs, not `2×` the confirmation time. Δ is sized to the
  slower/less-final chain.
- **The funding party's client MUST verify the ordering before locking value.**
  The Taker's client must check `t_BTC − t_RXD ≥ margin` before funding the BTC
  leg and refuse otherwise — a malicious counterparty can propose mis-ordered
  timelocks (fail closed).

> The exact margins here are **estimates** until derived from observed
> inter-block timing on the specific chains and depths in use. Don't ship a
> fixed constant without measuring.

---

## 4. Radiant's relative timelock is consensus-enforced

The HTLC refund path uses a *relative* timelock, and on Radiant that is
first-class — but the safety rests on the spending transaction, not the opcode
alone, so it's worth being precise:

- RadiantScript's `tx.age` compiles to `OP_CHECKSEQUENCEVERIFY` (CSV), an
  enabled opcode.
- Script-level CSV is a **standard** (mempool-policy) check, *not* a mandatory
  consensus flag — which on its own would be a weak guarantee.
- **But** transaction-level **BIP68 relative SequenceLocks are enforced at the
  block-validation layer** (`ConnectBlock`, the `bad-txns-nonfinal` gate) for
  version-2 transactions. So a refund tx that is `v2` with the correct
  `nSequence` is held back by *consensus* until its relative lock matures — not
  merely by mempool policy.

Takeaway: the refund leg's safety comes from the **spending tx's `v2` +
`nSequence`**, validated in `ConnectBlock` — confirm that, not just the presence
of the CSV opcode in the script.

---

## 5. What is retained vs. superseded

| Component | Status | Why |
|---|---|---|
| SPV-oracle **swap covenant** (finalize / forfeit; on-chain BTC-tx parser) | **Superseded for swaps** | The HTLC strictly dominates it — same goal, no S1 race, no on-chain BTC-tx parser. |
| SPV **verification primitive** (header-PoW, Merkle branch, payment verify) | **Retained, maintained** | Answers a question the HTLC cannot: prove a Bitcoin fact to Radiant with **no** Bitcoin-side counterparty and **no** Bitcoin-side script. |

The retained primitive is for the **no-counterparty** class of problem, where
non-atomicity is the *intended* semantics:

- **Bridge-in / mint-against-deposit** — BTC sent to an address ⇒ Radiant
  mints/releases. Nobody locks an RXD leg in return.
- **Gated release / paywall / faucet** — "prove you paid, get the thing."
- **Proof-of-payment receipts** for off-Radiant events.

An HTLC cannot serve these — there is no second party to lock a counter-leg or
to reveal a preimage. This is exactly why the primitive stays.

### The parser surface is why the swap covenant loses

The SPV-oracle swap covenant must **parse attacker-supplied Bitcoin transaction
bytes on-chain** to locate and validate the payment output. That parser is a
large, sharp attack surface: output-offset validation, signed/length-prefixed
fields, scriptSig size bounds, and chunked numeric comparisons each have to be
exactly right, and a single off-by-one is an asset-theft path. (This prototype's
own history shows the genre — e.g. the Phase-12 R1 chunked-compare sign-flip
fix.) An HTLC has **no output-scanning covenant and no BTC-tx parser at all** —
the Bitcoin script enforces the spend condition directly — so that entire class
of parser bug simply does not exist in the HTLC design. Where this prototype's
parser still has known rough edges, they live on the **superseded** path and are
documented, not fixed: there is no swap reason to keep hardening a parser the
HTLC removes.

---

## 6. Status and the audit gate

- The HTLC construction is the chosen direction for cross-chain swaps; the
  SPV-oracle swap covenant in this repo remains as a **research artifact** and
  for the no-counterparty primitive uses above.
- A working swap demo is **not** a security proof. **External audit of
  cross-chain atomicity is a hard gate before any real-value use** — the timelock
  ordering ([§3](#3-the-one-load-bearing-constraint-timelock-ordering)) and the
  retained-state / watchtower obligation are where a subtle implementation bug
  would hide.

---

## References

- This repo: [`S1_TIME_MODEL_LIMITATION.md`](./S1_TIME_MODEL_LIMITATION.md)
  (why the covenant can't express the deadline) and
  [`audits/04-atomic-swap-economic-security.md`](./audits/04-atomic-swap-economic-security.md)
  (the S1 finding).
- M. Herlihy, *Atomic Cross-Chain Swaps*, PODC 2018 — the timelock-ordering
  result in [§3](#3-the-one-load-bearing-constraint-timelock-ordering).
- Radiant Core consensus: BIP68 relative SequenceLocks enforced in `ConnectBlock`
  (`tx_verify.cpp`), CLTV/CSV opcodes in `interpreter.cpp`.
