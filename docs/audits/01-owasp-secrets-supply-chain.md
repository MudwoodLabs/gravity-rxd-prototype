# Audit 01 — OWASP / secrets / supply chain / CLI UX

Audited commit `d984701` (tip of `main`) on 2026-04-19.

---

## CRITICAL

### C1. Shell command injection in `broadcast --method ssh`
- File: `relayer/src/cli.js:261-263`
- The command string is built by interpolating `args.host`, `args.container`,
  `args.datadir`, and `txHex` directly into a shell string and passed to
  `execSync`. None of these are validated. `txHex` can also be the contents of
  a file the user passes via `--tx-hex <path>` (line 253-255). A malicious
  file or argument containing `"; rm -rf ~; echo "` would run arbitrary
  commands on the operator's machine, and the ssh part then runs arbitrary
  commands on the remote Radiant node. Because this is the **default**
  broadcast method (`method = args.method || 'ssh'`), every Radiant-relay
  operator is exposed.
- Fix: stop using `execSync` with interpolated strings. Either:
  - switch the default to `rpc` and deprecate the `ssh` method, or
  - use `child_process.spawn('ssh', [host, 'sudo', 'docker', 'exec',
    container, 'radiant-cli', ...])` with an argv array (no shell), and
    validate each of `host`, `container`, `datadir`, `txHex` against a strict
    allow-list (e.g. `txHex` must match `/^[0-9a-fA-F]+$/`, `host` must match
    `/^[a-zA-Z0-9._@-]+$/`).

### C2. Private-key WIF accepted on the command line
- Files: `relayer/src/cli.js:306, 323, 328`, `relayer/TRADE_FLOW.md:123`
- `btc-build-payment --privkey-wif $(jq -r .privkey_wif taker-btc-keys.json)`
  puts the WIF on `argv`, where it is visible to any local user via
  `ps auxww`, persists in shell history, and is captured by process-accounting
  tools. The docs themselves tell users to do this.
- Also: there is no `--privkey-file` equivalent for `btc-build-payment`.
  `build_cancel_tx.js` already uses `--privkey-file`; the relayer regressed.
- Fix: accept `--privkey-file <path>` and `--privkey-env <VAR_NAME>`. Refuse
  `--privkey-wif` on argv unless `--i-understand-argv-leaks` is also passed.
  Update `TRADE_FLOW.md` to use the file form. When reading from file, verify
  mode `0600` and owner = current uid.

---

## HIGH

### H1. Keypair generation defaults to a library RNG with no auditable source
- File: `relayer/src/btc_wallet.js:33-34`
- `ECPair.makeRandom({ network })` ultimately uses `randombytes` via
  `tiny-secp256k1` / `ecpair`. On Node 18+ that resolves to
  `crypto.randomBytes`, which is fine, but this is implicit — a future
  dependency bump or polyfill could silently swap to `Math.random`.
- Fix: pass `{ rng: (size) => require('crypto').randomBytes(size) }` to
  `ECPair.makeRandom`, and assert `typeof crypto.randomBytes === 'function'`
  at module load. Additionally, sanity-check generated privkey
  (`privkey !== 32-zero-bytes && privkey < curve_order`).

### H2. Generated keys printed straight to stdout with no confirmation
- File: `relayer/src/cli.js:292-295` (`cmdBtcKeygen`)
- `btc-keygen` does `console.log(JSON.stringify(kp, null, 2))` where `kp`
  contains the WIF. Terminal scrollback, tmux buffer, or CI-log-capture gets a
  permanent copy of the privkey.
- Fix: default to writing the WIF only to a file whose path is printed, with
  mode `0600`. Print address/pubkey to stdout. Print WIF only when
  `--print-privkey` is passed explicitly.

### H3. Local git refs contain the scrubbed email and would leak if pushed
- Refs: `refs/original/refs/heads/main`, `refs/original/refs/remotes/origin/main`,
  `refs/tags/pre-history-rewrite-backup`
- All three point at pre-filter-branch commits whose author email is
  `eric@vashontaskandtech.com`. A future `git push --tags` or
  `git push --mirror` would republish the old email on GitHub.
- Fix:
  ```
  git update-ref -d refs/tags/pre-history-rewrite-backup
  git update-ref -d refs/original/refs/heads/main
  git update-ref -d refs/original/refs/remotes/origin/main
  git reflog expire --expire=now --all
  git gc --prune=now --aggressive
  ```

### H4. Hard-coded absolute path to the author's home directory
- File: `validation/build_cancel_tx.js:23`
- `const rxd = require('/home/eric/apps/gravity-rxd-prototype/validation/node_modules/@radiant-core/radiantjs');`
  leaks the author's username/home-dir layout in published source and makes
  the file non-executable for anyone else who clones the repo.
- Fix: replace with `require('@radiant-core/radiantjs')`.

### H5. Documentation still contains personal-infrastructure remnants
- `HANDOFF.md:53` — `Branches staged locally at /home/eric/apps/RadiantScript/`
- `GRAVITY_ANALYSIS.md:253` — same reference
- Fix: replace with `~/path-to-your/RadiantScript` or similar placeholder.

---

## MEDIUM

### M1. `fetch` URL construction is not input-validated — mild SSRF risk
- Files: `relayer/src/btc.js:18-28`, `relayer/src/btc_wallet.js:104, 110`
- Paths like `/tx/${txid}/hex` concatenate user input to `BASE` with no
  validation. An attacker-supplied `txid` like `abc/../../admin?evil=`
  becomes `https://mempool.space/api/tx/abc/../../admin?evil=/hex`.
  If `MEMPOOL_API` env var is set to an attacker URL, they exfiltrate
  everything.
- Fix: validate `txid` against `/^[0-9a-fA-F]{64}$/`, `height` against
  `/^\d{1,9}$/`, `blockHash` against `/^[0-9a-fA-F]{64}$/`, and `address`
  against address-format regex before interpolation. URL-encode with
  `encodeURIComponent()`. Reject `MEMPOOL_API` values that aren't `https://`.

### M2. Deprecated `elliptic` dependency (GHSA-848j-6mx2-7j84)
- Transitive of `@radiant-core/radiantjs` 1.9.6 → `elliptic@6.6.1`.
- Fix not available upstream because `@radiant-core/radiantjs` caps at
  `^6.5.7`. Affects both `relayer/` and `validation/`.
- Fix: file upstream issue on `Radiant-Core/radiantjs`. Document the
  known-low finding in `SECURITY.md`.

### M3. Floating version ranges on all relayer dependencies
- File: `relayer/package.json:10-16`
- Every dep uses `^`, so a `npm install` on a fresh clone pulls a
  minor-version that has not been reviewed. For a tool that handles mainnet
  private keys, pin at least the direct security-critical deps
  (`bitcoinjs-lib`, `ecpair`, `tiny-secp256k1`, `@radiant-core/radiantjs`).
- Fix: change `^x.y.z` to exact `x.y.z` for those four. Document `npm ci`
  (not `npm install`) in `relayer/README.md` and `HANDOFF.md`.

### M4. `spvProof.raw_tx` treated as trusted input in `buildFinalizeTx`
- File: `relayer/src/finalize_tx.js:72-91`
- The caller passes a JSON file; the builder reads `raw_tx` without
  validating that it is hex, that its claimed length matches, or that it
  actually matches the `txid`. `Buffer.from(..., 'hex')` silently drops
  non-hex chars.
- Fix: enforce `/^[0-9a-fA-F]*$/` on `spvProof.raw_tx`, require even length,
  and re-verify `hash256(Buffer.from(raw_tx,'hex'))` matches `spvProof.txid`
  inside `buildFinalizeTx`.

### M5. Documentation claims "pure SPV" and "trustless" despite centralized feed
- Files: `README.md:3-5`, `docs/CHAIN_ANCHOR.md`
- The covenant is pure-SPV on-chain. But the relayer fetches headers, raw
  tx, and Merkle proofs exclusively from `mempool.space`. A user reading
  "trustless" might think the relayer doesn't need to be trusted.
- Fix: add a paragraph clarifying the relayer's data source is a trust
  assumption for liveness (not for security — bad data fails on-chain).
  Recommend running an own Bitcoin node in production.

---

## LOW

### L1. `raw_tx_hashes_to_txid` flag is trusted but producer is not
- File: `relayer/src/finalize_tx.js:62-65`
- If a user hand-edits a `spv-proof.json` to set the flag `true` but
  `raw_tx` is garbage, the guard passes. Covenant rejects on-chain.
- Fix: recompute inside `buildFinalizeTx` (see M4).

### L2. `outputOffset` prefix check trusts numeric input
- File: `relayer/src/finalize_tx.js:73-91`
- `outputOffset` comes from CLI via `Number(args['output-offset'])`.
  `Number('0x1')` is `1`, `Number('')` is `0`. A typo pointing at 0 could
  match tx-version bytes.
- Fix: `parseInt(..., 10)`; reject `NaN` and negatives.

### L3. No `SECURITY.md` for vuln reporting
- `CONTRIBUTING.md:27-29` says "Email the maintainer directly or use
  GitHub's security advisory feature" but no maintainer email and no
  `SECURITY.md` at the repo root.
- Fix: add `SECURITY.md` with (a) GitHub "Report a vulnerability" link,
  (b) expected response time, (c) disclosure policy.

### L4. `CODE_OF_CONDUCT.md` has no enforcement contact
- The Contributor Covenant v2.1 template expects an email; the repo's
  version is missing. Not a security bug; governance gap.

### L5. `broadcast --method ssh` host placeholder `<your-radiant-node-ssh>` is the default
- File: `relayer/src/cli.js:258`
- If a user runs `broadcast` without `--host`, the script runs
  `ssh <your-radiant-node-ssh> "..."`. Error message leaks the interpolated
  command including `txHex` to stderr.
- Fix: hard-error if `host` is the placeholder sentinel. Closes one path
  to C1.

### L6. `execSync` stdio pipes stderr to the Node process
- File: `relayer/src/cli.js:263`
- If the remote ssh command leaks info (full rawtx hex), it prints to
  stderr — CI logs capture it.
- Fix: redact the tx hex when printing the error.

---

## INFO

- **I1. `qrcode` dependency appears unused** — `relayer/package.json:14`. Remove.
- **I2. Multiple `bs58` versions** — `bs58@4.0.1` and `bs58@6.0.0` both present.
- **I3. No `npm ci` verification in HANDOFF.md setup instructions** — `npm install` respects `^` and can drift.
- **I4. `.gitignore` does not exclude `*.key`, `*.wif`, `*-keys.json`** — defensive rules would reduce accidental commits.
- **I5. Commits pair (odd/even) in git log** — cosmetic side-effect of stale `refs/original/*` (see H3).

---

## Top 5 most pressing

1. **C1** — shell injection in `broadcast --method ssh` (default).
2. **C2** — `--privkey-wif` on argv as documented flow.
3. **H3** — `refs/original/*` + backup tag still contain the scrubbed email.
4. **H4/H5** — hard-coded `/home/eric` paths leak username.
5. **M4 + L1** — relayer trusts proof-file self-claims instead of recomputing.
