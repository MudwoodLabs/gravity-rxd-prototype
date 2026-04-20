# Legacy contracts — DO NOT DEPLOY

These `.rxd` files are earlier versions that lack security fixes required for
any adversarial deployment. They are kept only as a historical reference for
reviewers reading the repo's audit reports (`docs/audits/`).

## What's missing from these files

Compared to the current `generators/gen_maker_covenant.js` output:

- **No chain-identity anchor** (`docs/CHAIN_ANCHOR.md`). A cross-network SPV
  proof could be substituted.
- **No flexible Merkle anchor** — requires the payment tx to land in `h1`
  only, giving the Taker ≤ 1 block instead of N.
- **P2PKH-only payment verification** — does not dispatch on P2WPKH, P2SH,
  or P2TR.
- **No `nBits` upper bound** — even after the generator is updated, the
  committed versions would still be forgeable (see audit 03 finding C1).
- **No structural tx-parse on payment output** — attacker-chosen
  `outputOffset` lets a crafted OP_RETURN pattern bypass the payment check
  (see audit 03 finding C2).

## maker_claimed_stub.rxd

Hand-written stub of the State-2 covenant used for early development. Its
`finalize()` has NO SPV verification — it only routes output to
`takerRadiantPkh`. Deploying this file would let ANY party spend the UTXO
by producing a P2PKH output to takerRadiantPkh, total loss. Kept only as
a reference implementation of the stateSeparator pattern.

## maker_offer_simple.rxd

An earlier MakerOffer variant that explicitly skips the Taker signature
on `claim()` for testing purposes. Deploying it would reintroduce audit
finding S3 (permissionless state advance, griefing vector). Use
`contracts/maker_offer.rxd` instead, which requires a Taker signature.

## Authoritative source

The current covenant source is **`generators/gen_maker_covenant.js`**.
Regenerate per deployment:

```
node generators/gen_maker_covenant.js --btc-type <p2pkh|p2wpkh|p2sh|p2tr> \
    --flat --anchor-height <H> --anchor-hash <hash> \
    --expected-nbits <current-retarget-nbits-LE> > deploy.rxd
```

(Exact flags evolve — consult the generator source.)
