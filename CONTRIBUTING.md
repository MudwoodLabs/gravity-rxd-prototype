# Contributing to gravity-rxd-prototype

Thanks for your interest. This is a prototype that demonstrates the
Gravity protocol works on Radiant mainnet. Contributions are welcome
from developers, researchers, and anyone who wants to move this
toward a production design.

## Before opening an issue or PR

1. Read [`README.md`](./README.md) for the overview + current state
2. Skim [`GRAVITY_ANALYSIS.md`](./GRAVITY_ANALYSIS.md) for the design
   rationale and every measured result
3. Check [`HANDOFF.md`](./HANDOFF.md) for setup instructions and the
   "what's not done" list
4. Check existing issues + PRs to avoid duplication

## Ways to contribute

### Bug reports

- **RadiantScript compiler bugs**: see [`UPSTREAM_BUGS.md`](./UPSTREAM_BUGS.md)
  — 3 documented, not yet upstreamed. If you want to own upstreaming
  any of them, open an issue here first so we can coordinate.
- **Bugs in this prototype**: open a GitHub issue with a minimal
  reproducer. Attach compile output, relayer CLI output, or a txid
  where possible.
- **Security issues**: if you find something that would let an
  attacker steal funds, please do not open a public issue. Email the
  maintainer directly or use GitHub's security advisory feature.

### Code contributions

**Small fixes / cleanups**: open a PR directly. Good first-PR candidates:
- Typo fixes in documentation
- Additional reference-implementation test cases
- Relayer CLI improvements (better error messages, edge-case handling)
- Test coverage (no test suite exists yet — see below)

**Larger changes**: open an issue first to discuss scope. Anything
touching covenant semantics, consensus-level behavior, or the
anchoring design should get discussed before you write the PR.

### Priority areas

In rough order of value:

1. **Test suite** — the whole prototype has no automated tests. Any
   contribution here is high-leverage.
2. **REP draft** — formal Radiant Enhancement Proposal for the
   protocol. Good for anyone familiar with Radiant governance.
3. **Multi-way extension** — Gravity paper §5 (Radiant as bond for
   any-two-PoW trades). Substantial design work.
4. **Order-book / discovery layer** — the protocol works but there's
   no way for Makers and Takers to find each other off-chain.
5. **Web UI** — right now everything is CLI. A minimal web frontend
   would lower the adoption barrier significantly.
6. **Alternate binding designs** — current P2SH binding requires
   Maker to commit to Taker pkh at offer time. A stateSeparator-based
   binding would allow variable Taker pkh; see `GRAVITY_ANALYSIS.md`
   §10o for the starting point.

## Development setup

See [`HANDOFF.md`](./HANDOFF.md) §"Environment setup".

Short version:
```bash
git clone https://github.com/Zyrtnin-org/gravity-rxd-prototype.git
cd gravity-rxd-prototype/relayer && npm install
cd ../validation && npm install
```

Plus you'll need the `rxdc` RadiantScript compiler built from source —
see `HANDOFF.md` for the three upstream bug fixes currently required.

## Code style

- **JavaScript**: follows the existing patterns. No linter configured
  yet; match the surrounding code.
- **RadiantScript (`.rxd`)**: generated from `generators/`. Don't edit
  generated files by hand; update the generator and regenerate.
- **Documentation**: prose over bullets where reasonable; include
  measured numbers wherever possible rather than estimates.

## Commit messages

Keep them factual. We use `Co-Authored-By:` trailers when collaboration
happens. Example:

```
Fix segwit stripping for 1-input Taproot txs

Witness count was parsed as 1 byte instead of varint, causing
single-input Taproot txs with >252 witness elements to fail the
strip. Tested against mainnet tx abc123...

Co-Authored-By: Someone <their@email>
```

## PR expectations

- Small, focused PRs are strongly preferred
- Include a brief description of what changed and why
- If adding a feature, update the relevant doc (`README.md`,
  `HANDOFF.md`, or `GRAVITY_ANALYSIS.md`)
- If fixing a bug, include the scenario that triggered it

## Scope discussion

Some things are out of scope for this repo:

- Changes to the Gravity paper's protocol design — those go to the
  paper author / Radiant-Core team
- Radiant consensus-level changes — those go to `Radiant-Core/Radiant-Core`
  or as REPs at `Radiant-Core/REP`
- RadiantScript compiler changes — those go to `Radiant-Core/RadiantScript`
  (the 3 bugs in `UPSTREAM_BUGS.md` are ready to PR there)

If your contribution touches any of the above, let's talk first about
whether it belongs here or upstream.

## Code of conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Short version:
assume good faith, critique ideas not people, respect disagreement.

## License

By contributing, you agree your code will be released under this
repository's [MIT license](./LICENSE).
