# Session narrative

A prose log of the development session that produced this prototype. This
complements `HANDOFF.md` (which captures final state) by preserving the
*thinking path* — design questions that got asked, alternatives considered,
and the framing decisions that shaped the work.

Written 2026-04-18.

---

## Starting point

The conversation began with a PDF: `gravity.pdf`, the Gravity protocol
whitepaper describing a peer-to-peer cross-blockchain exchange using
Simplified Payment Verification and Radiant-side covenants. The user
wanted to know what it meant for Radiant.

Early exploration answered a related question: **is this the same as
Atomicals?** The conclusion: no, not the same tech, only shared
philosophical lineage. Atomicals is a Bitcoin-native token protocol
with indexer-based overlays; Gravity is a Radiant-native covenant system
that validates Bitcoin SPV proofs on-chain. Atomicals' token model was
borrowed for Radiant's Glyph protocol (separate concern), but Gravity
is a different problem class.

A deeper look at the Radiant-Core GitHub org revealed:
- `Project-Gravity` exists but contains only the PDF + LICENSE + README
- The roadmap places Gravity in Phase 4 (6-12 months out) with language
  suggesting a possible retreat from the paper's pure-SPV design toward
  a weaker federated-signer model
- No implementation code anywhere
- No REP (Radiant Enhancement Proposal) had been drafted

This framed the strategic question: **is there a role for outside
contribution here?**

## The "should we drive this" decision

We stepped through honest analysis. Arguments for building:
- Paper with no implementation = clear gap any credible contributor can fill
- Radiant's script has the primitives needed (32 MB script size, big
  integers via chunking, hash256 / reverse / split / cat all available)
- Credible prototype would move the conversation from "theoretical"
  to "engineering" and could reshape Radiant's roadmap direction

Arguments against:
- Unknown whether core team would accept outside contribution
- Federated-signer direction might be locked in for non-technical
  reasons (simpler to ship, no REP debate needed)
- Multi-week effort before knowing if it lands

The user decided to build, not probe. Reasoning: "it's a community
driven project where anyone can do anything, SPV is superior, so we
should do it."

## Feasibility establishment

Before writing covenant code, we established that the primitives
actually compile. First attempt: install rxdc (the RadiantScript
compiler) from npm. Failed — `rxdc` isn't published. Had to build
from source.

Building revealed three real bugs in Radiant-Core/RadiantScript master
branch:
1. Duplicate property keys in `packages/cashc/src/generation/utils.ts`
2. Leftover `@cashscript/utils` imports (should be `@radiantscript/utils`)
3. `OP_BLAKE3` / `OP_K12` referenced but undefined (v2 opcode additions
   incomplete)

We patched all three locally and documented them in `UPSTREAM_BUGS.md`
for future PR submission. The fact that these blocked a fresh build
suggests nobody had built rxdc from master recently — a weak signal
about the activity level of Radiant's core dev.

With rxdc working, we probed primitives one at a time:
- `hash256(x)` → single `OP_HASH256` ✓
- `.split(n)[i]` → `OP_SPLIT` + `OP_DROP/NIP` ✓
- `.reverse()` → `OP_REVERSEBYTES` (Radiant-specific) ✓
- `int(bytes)` → `OP_BIN2NUM` ✓
- `bytes(0, runtime_n)` → `OP_NUM2BIN` with runtime size ✓
- 32-byte chunked comparison (for 256-bit unsigned < check) → 116 bytes

**Key discovery**: Radiant's CScriptNum is 64-bit signed. Naive
8-byte chunk comparison fails on hashes with high-bit-set chunks.
Solution: 4-byte chunks (always positive in int64, 4 × 8 = 32 bytes).
This design detail took an iteration to get right.

With primitives validated, we wrote a complete single-header
proof-of-work verifier: 272 opcodes, 402 bytes. That was the first
milestone — proving the paper's cryptographic claims were within
reach of Radiant's scripting capabilities.

## Scaling up

From one header to six (the paper's recommended minimum security
depth):

- Wrote `gen_chain.js` to produce parameterized N-header chain
  verifiers
- Measured scaling: exactly 280 ops per additional header, perfectly
  linear
- 6-header chain: 1,672 ops / 2,479 bytes — trivial
- 144-header chain (a full day of Bitcoin blocks): ~40k ops / ~60 KB —
  still 0.2% of Radiant's 32 MB script limit

**Observation**: "no new opcodes needed" came into focus. Every
component we needed was already in Radiant's instruction set from
earlier versions; Gravity is an *engineering* project, not a research
project.

Then similar scaling analysis for the Merkle branch verifier (up to
depth 20) and the Bitcoin payment verifier. The payment verifier was
surprisingly small — 25 ops — because of a pragmatic decision to
delegate output-offset computation to the Taker off-chain, rather
than parse varints on-chain.

## First mainnet validation

At this point the prototype worked in theory and compiled cleanly.
The user pushed for mainnet validation specifically — not just
algorithmic validation via reference implementations, but actual
on-chain execution under Radiant consensus rules.

This mattered because **compilation doesn't prove correctness of
the compiler's output**. A bug in rxdc's code-gen, or a mismatch
between our mental model of Radiant's opcodes and their actual
consensus semantics, wouldn't surface without real broadcast.

Funded a P2SH UTXO wrapping the single-header verifier. Tried to
spend it with block 840000's header as witness. First attempt failed
with `min relay fee not met` — Radiant's effective min relay is 0.1
RXD/kB (10,000 sat/byte), **10× higher than BCH**. Had to re-fund
with larger amount.

Second attempt succeeded: tx `a0e10946…7409` confirmed in block
`00000000000000606f…a54`. First on-chain validation of any Gravity
covenant mechanism.

This was the key inflection point. From this moment onward, every
claim could be backed by a concrete txid.

## Primitive-by-primitive validation

Followed with mainnet runs for each remaining component:
- 2-header chain with linking: `9a8a6b2e…32173`
- Merkle branch: `2d90a6bb…8127`
- Payment parsing: `339866d8…819c`

Four individual SPV primitives validated. Session cost to that point:
about 0.23 RXD (under a cent).

## The state machine

Individual primitives weren't enough. The real test: executing the
complete state machine (MakerOffer → claim → finalize/cancel/forfeit)
on mainnet.

Initial implementation had a weak security property: `MakerOffer.claim()`
only checked output value, not the structure of the resulting UTXO.
A malicious Taker could route photons anywhere, not just to a proper
MakerClaimed covenant.

The fix required understanding Radiant's `codeScript` vs `stateScript`
semantics. Dev docs said one thing; source code said another. We read
`src/script/interpreter.cpp` directly to resolve: **codeScript is the
bytes from `OP_STATESEPARATOR` to end** (inclusive of the separator
byte), not before as the docs suggested.

But for P2SH-wrapped covenants — our deployment model — the
stateSeparator is moot. The output scriptPubKey is just
`OP_HASH160 <20B> OP_EQUAL`. `OP_CODESCRIPTBYTECODE_OUTPUT` on a P2SH
output returns the full 23-byte scriptPubKey.

So the correct production binding: `expectedClaimedCodeHash =
hash256(P2SH_scriptPubKey_of_MakerClaimed)`.

Wrote `reference/extract_p2sh_code_hash.js`. Compiled a MakerOffer
with the correct binding. Validated MakerOffer.cancel() on mainnet
first (`9ab535ab…f778`), then did the full bound Path A:
- Funded MakerOffer P2SH: `ad3f1e26…9218`
- **claim()** spent the offer, creating MakerClaimed UTXO:
  `4e292c30…d679`
- **finalize()** consumed MakerClaimed with real BTC 840000 SPV proof:
  `2455ed84…c9bb`

Full state machine executed on mainnet with cryptographically
enforced binding.

## A discovered fee constraint

Early in the MakerOffer cancel attempt, script failed with
`mandatory-script-verify-flag-failed`. Root cause: we pushed the
function selector as a 1-byte `0x00` push (opcode `0100`), but
`SCRIPT_VERIFY_MINIMALDATA` requires canonical encoding — value 0
must be `OP_0` (empty push), not a 1-byte `0x00`.

Relayer fix: use `Buffer.alloc(0)` for zero-value selector pushes.
Documented for future maintainers.

## BTC-side tooling

Radiant-side was validated. For real user trades, we needed
Bitcoin-side tooling too: generate keypairs, query UTXOs, construct
and sign payment txs, broadcast.

Added `bitcoinjs-lib` as a dependency and wrote four CLI commands:
`btc-keygen`, `btc-get-utxos`, `btc-build-payment`, `btc-broadcast`.

Initially the payment builder only produced legacy (non-segwit) txs
because the Gravity covenant does `hash256(raw_tx)` which only equals
the txid for non-witness serialization. The user asked about segwit
support — how much would that take?

**Turned out to be mostly a relayer problem, not a covenant problem.**
For Taker-side segwit: the relayer just strips witness bytes before
passing to the covenant. `btc_wallet.js::stripWitness()` handles this
transparently; `fetch-spv-proof` auto-strips by default.

Validated against a real segwit tx from block 840000: 329 bytes
(with witness) → 136 bytes (stripped), hash256 now equals txid.

What DID require covenant changes: Maker receiving to non-P2PKH
addresses. We implemented Phase 1 (P2WPKH) and Phase 2 (P2SH, P2TR)
in a single pass — `gen_maker_covenant.js` gained a `--btc-type`
option that can emit per-type (smaller script) or `--btc-type all`
(runtime-dispatch, +117 ops). Each type adds ~30 ops to the covenant.

Updated `btc-keygen` to emit all four address formats from a single
keypair.

## The chain-anchoring insight

Just before planning the real-BTC mainnet demo, the user raised a
security concern: adding testnet support to the relayer could
contaminate production code paths. Were there any *protocol-level*
safeguards against testnet SPV forgery?

The answer was no. Our covenant's PoW check validates that a chain
was expensive to produce, but not *which* chain. Testnet is cheap to
mine. A forged testnet chain could "prove" a payment that never
happened on mainnet.

This was a real production blocker. We designed **chain-identity
anchoring**: Maker commits at offer time to a specific known-good
mainnet block hash. Covenant verifies h1's prevHash matches that
anchor. Without this, the covenant is network-unsafe; with it,
forging becomes as expensive as forging real mainnet PoW.

Cost: +6 opcodes / +19 bytes. Essentially free for full cryptographic
network-identity protection. Committed to main as a production-safety
cornerstone.

## The flexible-Merkle-anchor follow-up

Initial anchor design had a subtle usability bug: strict `h1.prevHash ==
anchor` meant the Taker's payment must land in block `anchor+1` exactly
— only ~5 minutes of practical window.

The user asked: is relaxing this to "any of h1..hN" a security loss
or an architectural improvement?

**Architectural improvement.** Security comes from the N-block PoW
depth plus the anchor; which specific block within those N contains
the tx is irrelevant to attacker cost. The paper's implicit design
assumes flexibility — the strict version was just a code-simplicity
shortcut.

Cost: +47 ops / +91 bytes. Widens window from 5 min to ~1 hour
(for N=6) or ~1 day (for N=144).

This is the final form of the covenant.

## Where we stopped

The prototype is engineering-complete:

- Every script primitive validated on mainnet
- Full state machine (MakerOffer → claim → finalize) validated with
  proper binding
- Chain-identity anchoring prevents cross-network forgery
- Flexible Merkle anchor gives practical payment window
- All four BTC address types supported
- Segwit/taproot Taker wallets work via auto-strip
- Relayer has 9 CLI commands covering both sides
- 16 commits on the repo, all pushed

Pending work before the real mainnet demo could execute:
- Small BTC wallet (~5,000 sats) to fund the Taker payment
- ~1 hour window to run through the sequence

Pending work for public contribution:
- File the 3 upstream bugs as PRs
- Draft the REP
- Decide on public repo

These are not script-level unknowns — they're publishing and
coordination tasks.

## Session cost accounting

All mainnet validations combined cost less than 1 RXD (~fractions of
a cent in USD). A working prototype of a protocol proposed in a
whitepaper with no prior implementation, validated on production
infrastructure, for pennies of fees. That cost ratio is the actual
power of Radiant's low-fee economics in action — we could afford to
validate every edge case on chain rather than solely in simulation.

## Framing questions the user raised (and their answers)

Recorded for posterity, because these shaped the work:

**"Are we able to help drive that gravity protocol?"** — Yes. Paper
with no implementation is the ideal contribution surface. Key leverage
points are writing the REP, building the prototype, and contributing
opcodes if needed (turned out unneeded). The probe-first approach was
floated and then deprioritized when the user decided to just build.

**"Is it possible to send a btc testnet txn via gravity?"** — Triggered
the chain-anchoring discussion. The answer evolved: yes technically,
but only safe if the covenant has a network-identity check. That check
didn't exist; we built it.

**"Does relaxing the anchor constraint lessen security?"** — No, it's
an architectural improvement. Strict h1-only was a code-simplicity
shortcut, not a security feature. Flexible anchor aligns with the
paper's implicit design.

**"Is there any risk beyond the test cost?"** — Surfaced the
tight-window risk (only 5 min to get BTC into block anchor+1 in the
strict design). This motivated the flexibility improvement before any
real trade attempt.

**"So we developed the Gravity Protocol into a working product on
mainnet?"** — The answer required honesty: we built a **working
prototype** that validates the protocol works, not a **product**. The
difference matters: no audit, no UI, no discovery layer, no test
suite. But the core claim of the paper is now demonstrably true.

---

This narrative is not a replacement for `HANDOFF.md`, which is the
structured project-state reference. It's a complement for when you
(or a future collaborator) want to understand the *why* behind the
design choices, not just the *what*.
