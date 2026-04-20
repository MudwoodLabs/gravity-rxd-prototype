# Security Policy

## Status of this repository

This is a **research prototype**. A 2026-04-19 internal security review
identified multiple show-stopper issues (see [`docs/audits/`](./docs/audits/)).
Phases 1-6 of remediation have closed every original show-stopper.

One architectural limit remains on the **S1 finalize/forfeit race**: it can
only be mitigated at the tooling level because RadiantScript has no
"current time" primitive at claim time. See
[`docs/S1_TIME_MODEL_LIMITATION.md`](./docs/S1_TIME_MODEL_LIMITATION.md)
for the full explanation — what the covenant can and cannot enforce, what
we do off-chain instead, and what a counter-party is actually trusting.

Do not hold value in this covenant without independent Taker-side
verification as described there.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive findings.

Use GitHub's private vulnerability reporting:
<https://github.com/Zyrtnin-org/gravity-rxd-prototype/security/advisories/new>

Expected response time: within 7 days for acknowledgement.

## Scope

In scope:
- Covenant logic flaws that let a Taker spend without a real BTC payment,
  or a Maker double-spend after Taker has paid BTC.
- Relayer RCE / privkey-exposure bugs.
- SPV proof malleability or verification bypasses.
- Generator-vs-generated covenant drift that weakens security.

Out of scope (known):
- Single-point-of-trust on mempool.space for relayer data (documented;
  multi-source support planned).
- Single-Taker-at-offer-time binding (documented; stateSeparator-based
  redesign planned).
- General SPV-inherent concerns (CVE-2012-2459, 64-byte tx ambiguity) if
  the covenant-side mitigations are already queued.

## Disclosure

We ask for 90 days to fix before public disclosure. If we haven't
responded within 14 days, feel free to escalate by any public channel.

## Related repositories

Some issues may belong upstream:

- **RadiantScript compiler bugs:** [Radiant-Core/RadiantScript](https://github.com/Radiant-Core/RadiantScript)
  (3 existing bugs documented in [`UPSTREAM_BUGS.md`](./UPSTREAM_BUGS.md)).
- **Radiant consensus:** [Radiant-Core/Radiant-Core](https://github.com/Radiant-Core/Radiant-Core)
  or as a REP at [Radiant-Core/REP](https://github.com/Radiant-Core/REP).
