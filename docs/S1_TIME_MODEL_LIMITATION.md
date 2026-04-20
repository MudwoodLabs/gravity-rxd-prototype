# S1 — the covenant-level time-model limitation

Audit finding **S1** (from [`docs/audits/04-atomic-swap-economic-security.md`](./audits/04-atomic-swap-economic-security.md))
describes the finalize/forfeit race that opens when `claimDeadline` is set
too close to "now." The covenant enforces
`require(tx.time >= claimDeadline)` in `forfeit()`, which means the
forfeit path is spendable the moment wall-clock time crosses
`claimDeadline`. If the Maker can pick a `claimDeadline` in the past,
`forfeit()` is open immediately after the Taker's `claim()` advances
state — and the Maker can race-broadcast a forfeit to snipe the Taker's
BTC payment for nothing.

This note explains why the covenant cannot directly prevent that, what
we mitigate client-side, and what a counter-party is actually trusting
when they use the prototype.

## What the covenant "should" enforce

The ideal check is:

> At deploy time, `claimDeadline > now + safetyWindow` (where
> `safetyWindow` is large enough to accommodate BTC confirmation +
> proof generation + Radiant inclusion — at least 24 hours).

That check is what closes S1 for any Maker, honest or otherwise.

## Why RadiantScript can't express it

RadiantScript has exactly one time primitive: `tx.time`, which compiles
to `OP_CHECKLOCKTIMEVERIFY` (CLTV). CLTV reads the *spending
transaction's* `nLockTime` field.

- `nLockTime` is set by the party building the spending tx. At claim
  time that's the Taker; at forfeit time that's the Maker (or any
  relayer).
- `OP_CHECKLOCKTIMEVERIFY` only expresses `tx.nLockTime >= X`. Combined
  with consensus rule "the tx cannot mine until
  `block.mediantime >= tx.nLockTime`," this gives a *future lower
  bound*: "this tx will not mine until time T."
- There is **no opcode** that reads `block.mediantime`, `block.height`,
  or any other "now" value directly.

Concretely, the covenant can enforce:

- ✓ "Forfeit can't mine before `claimDeadline`" (via CLTV in
  `forfeit()`).
- ✓ "`claimDeadline` is larger than some constant baked at generation"
  (via integer comparison against a literal).

The covenant cannot enforce:

- ✗ "`claimDeadline` is in the future at the moment of deployment."
- ✗ "The Maker is not lying about what 'now' was when they deployed."

That is a property of the scripting model, not an oversight in the
covenant source.

## What we actually do

Layered defense:

1. **Generation-time floor (on-chain).** `generators/gen_maker_covenant.js`
   computes `CLAIMDEADLINE_FLOOR = Math.floor(Date.now()/1000) - 30d`
   at generator run time and emits
   `require(claimDeadline >= <floor>)` into the covenant source. If a
   Maker regenerates the covenant today, the floor is "30 days ago at
   worst." That alone prevents `claimDeadline = 0` and the
   years-in-the-past static constants Phase 3 shipped with. It does
   **not** prevent a Maker who regenerates monthly from picking
   `claimDeadline` anywhere in the ~30-day-rear window.

2. **Client-side deploy guard (off-chain).**
   `reference/extract_p2sh_code_hash.js` refuses to compute a P2SH code
   hash when `claimDeadline < now + 24h`, with a `--i-understand-short-deadline=true`
   bypass that carries a loud social-eng warning. If the Maker uses our
   deploy tooling honestly, this closes S1 for them.

3. **Taker-side re-verification (off-chain, required).**
   [`relayer/TRADE_FLOW.md`](../relayer/TRADE_FLOW.md) step 3 instructs
   the Taker to re-run `extract_p2sh_code_hash.js` independently with
   the Maker-advertised parameters and compare the resulting hash
   against:
   - the hash Maker advertised off-chain, and
   - the `expectedClaimedCodeHash` the deployed MakerOffer actually
     commits to.

   If the client-side guard fails during the Taker's re-run (e.g.
   "claimDeadline short"), or the hashes don't match, the Taker MUST
   refuse the offer.

## What a counter-party is actually trusting

When Taker accepts a Gravity offer, they are trusting (in addition to
Bitcoin PoW and Radiant consensus):

- That they correctly re-ran `extract_p2sh_code_hash.js` with the
  Maker-advertised parameters.
- That the client-side 24h guard is a sufficient floor for the trade
  they're executing.
- That they did **not** pass `--i-understand-short-deadline=true`
  because someone asked them to.

These are social / process assumptions, not cryptographic ones. For
cooperative-OTC trades between parties who already know each other,
they are reasonable. For adversarial public deployment, they are not
enough — a sophisticated malicious Maker can hand-craft deploy tooling
that bypasses the client-side guard and still produces a covenant that
accepts their out-of-range `claimDeadline`. The only cryptographic
protection the Taker has in that scenario is the Taker-side
re-verification catching the short deadline before they broadcast
`claim()`.

## The exploit that remains open

A Maker who:

1. Hand-writes their own deploy tooling (bypasses the client-side
   24h guard).
2. Regenerates the covenant source today (gets a fresh 30-day-rear
   floor baked in).
3. Sets `claimDeadline` to a value ≥ the baked floor but in the past
   relative to real-world time (e.g. yesterday).
4. Advertises the resulting P2SH to a Taker who does **not** re-verify.

...can race the forfeit path immediately after the Taker's `claim()`
confirms, capturing the Taker's BTC and the pre-locked RXD both.

The Taker's defense is step 3 in the list above: re-running
`extract_p2sh_code_hash.js` with Maker's advertised parameters, which
will error on the past-dated deadline.

## Future paths

**Option A — SPV-oracle the forfeit path.** Require `forfeit()` to
present a recent Bitcoin header whose `nTime > claimDeadline -
safetyWindow`. The covenant can verify the header via the existing PoW
+ chain primitives. This gives the covenant an on-chain, Maker-
unforgeable clock. Cost: doubles the forfeit path's script weight
(adds ~2,000 ops) and plumbs SPV data through forfeit (which is
currently a plain CLTV check). Real fix for adversarial deployment.

**Option B — Radiant consensus change.** Add an opcode like
`OP_BLOCKTIME` / `OP_BLOCKHEIGHT` that exposes the current block's
timestamp or height. Covenants could then directly express
"`claimDeadline > block.time + safetyWindow`." Requires a REP and a
soft-fork; entirely out of this prototype's scope.

**Option C — accept the architectural limit.** Rely on honest tooling
+ mandatory Taker re-verification. Where we are now. Fine for
cooperative/OTC counter-parties; not fine for a public order book
against unknown Makers.

## Related

- [`docs/audits/04-atomic-swap-economic-security.md`](./audits/04-atomic-swap-economic-security.md)
  — audit finding S1 in context (economic severity, reorg, binding).
- [`generators/gen_maker_covenant.js:242-262`](../generators/gen_maker_covenant.js#L242-L262)
  — the floor's implementation and the generator-time comment.
- [`reference/extract_p2sh_code_hash.js:131-162`](../reference/extract_p2sh_code_hash.js#L131-L162)
  — the 24h client-side guard and its bypass semantics.
- [`relayer/TRADE_FLOW.md`](../relayer/TRADE_FLOW.md) step 3 — the
  Taker-side re-verification procedure.
