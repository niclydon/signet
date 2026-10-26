# Signet

Provenance seals for agent-written content.

A signet seal binds three things into one public record: a hash of the
exact text, a wallet signature over that hash, and a live check that
the signing wallet is registered to a verified unique human. Anyone
can re-run all three checks from the record alone, and verification
reports each check separately, with named failure states, never a
single collapsed "invalid".

A seal does not claim a human wrote the text. It claims the opposite
posture, stated plainly: an agent wrote this, and the wallet that
sealed it is backed by a verified human who can be held to it.

## The three checks

1. Content: SHA-256 over the canonical text form (`w3-text-v1`: UTF-8,
   LF line endings, Unicode NFC, the committed source rather than any
   rendered form) matches the bytes being read.
2. Signature: an EIP-191 signature by the sealing wallet over a
   domain-separated payload naming the surface and the content hash.
3. Registration: at check time, the signing wallet resolves in the
   AgentBook registry to a verified unique human. Verification
   reports the hash of that registration, never the underlying
   identifier.

Verification returns a `w3-verify-result/1` document. Its failure
states are data, not vibes: `no-seal-found`, `content-mismatch`,
`signature-mismatch`, `wallet-not-registered`, `seal-superseded`,
`approval-not-confirmed`, `anchor-invalid`, and `check-incomplete`
(a check that could not run, for example a registry read failure,
which is never reported as "not registered").

## Honest time

A seal carries the signer's claimed sealing time. Stronger evidence
is layered and labelled: the git commit that published the seal, and
optionally an anchor of the seal hash on World Chain, which proves
the hash existed no later than that block and nothing earlier.
Unanchored seals say so.

## Edits and approval

Content that changes gets a new seal; seals are never mutated, and a
superseded seal verifies as superseded, with a link to its successor.
A separate human-approved tier exists in the format for content a
human reviewed and approved through a signed approval record bound
to the exact content hash. It is disabled in this release: everything
publishes as not-approved, and any approved claim fails verification
as `approval-not-confirmed`.

## Repository layout

- `src/canonicalize.js`: `w3-text-v1` canonicalisation.
- `src/seal.js`: seal creation, the signed-core/annotation split
  (post-signing annotations such as the anchor are verified against
  their external sources, so anchoring cannot invalidate a seal).
- `src/verify.js`: verification returning `w3-verify-result/1`.
- `src/anchor.js`: the anchor provider interface and a mock local
  chain. The World Chain provider is stacked behind the interface
  until the production sealing wallet is funded.
- `src/agentbook-w0.js`: adapter that resolves a wallet's
  registration through a W0-compatible verifier.
- `bin/w3-seal.js`: the command line tool.
- `tests/`, `vectors/`: the test suite and the canonicalisation
  vectors, the latter byte-checked against an independent Python
  generator. `TEST-EVIDENCE.md` records what was run and what it
  proved.

## Quickstart

```sh
npm install
npm test
```

## Relation to C2PA

C2PA proves media provenance under X.509 signers on a trust list.
Signet binds text to a wallet whose registration to a unique human
is checked live. Different claims, different signer models; a signet
record is not a C2PA manifest and does not claim to be one.

## License

Apache-2.0.
