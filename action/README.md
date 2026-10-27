# The Signet sealing Action

Seals changed content at publish time and proves the behaviour in
pull requests without recording anything. This implements section
9 of the design spec.

## Pieces

- `seal-run.mjs`: the sealing run itself. One function with every
  side effect injected, tested offline in `tests/action-seal.test.js`.
- `action.yml`: a composite action wrapping the run.
- `../.github/workflows/seal-reusable.yml`: the reusable workflow
  publishing repositories call. It handles key custody, the
  commit-back, loop prevention, PR comments, and the
  anchor-pending tracking issue.
- `../examples/caller.yml`: the thin caller a publishing repo
  copies in. `../examples/signet.config.json`: an example surface
  config.

## Surface config

One small JSON file per publishing repository, public like
everything else in that repo:

| Field | Meaning |
| --- | --- |
| `surface` | The surface name written into every seal. |
| `persona` | The agent persona name written into every seal. |
| `canonicalUrlBase` | Base the content's canonical URL is built from (base + repo-relative path). |
| `content` | Globs selecting sealable content. |
| `exclude` | Globs removed from the selection (drafts, private posts). |
| `hashScope` | `file` hashes the whole file; `body` hashes only the body after front matter (the personal-website rule in the spec). |
| `sealsDir` | Where seal records live. Default `_seals`. |
| `approval.required` | When true, publication needs a confirmed approval record for the content hash. |
| `approval.fallback` | `fail` closes publication; `not-approved` publishes a not-approved seal. |
| `approval.recordsDir` | Directory of approval records, one `<hash>.json` per hash with `{ "content_hash": ..., "confirmed": true }`. |
| `anchor.required` | When true, an anchor failure fails the run closed. Default false: fail-open with disclosure. |
| `anchor.retries` | Anchor attempts before the failure posture applies. |
| `anchor.command` | Optional command that anchors a hash: it receives the content hash as its only argument and prints the anchor JSON on stdout. When null, seals publish unanchored and the summary says so. |

## Behaviour, in the spec's order

1. Resolve the changed content set from the event, filter by the
   config globs and exclusions.
2. Canonicalise under w3-text-v1 and compare against the committed
   bytes. A file that is not already canonical fails the whole run
   closed: the Action verifies, it never silently rewrites
   published words.
3. Skip content whose hash already has a seal for this surface and
   content_id (idempotent re-runs mint no duplicates). Changed
   content gets a new seal whose `supersedes` points at the
   previous hash.
4. Approval gate: with `approval.required`, look for a confirmed
   record for the hash. The gate enforces the surface's
   publication policy only; it never writes an approval claim
   into a seal and never manufactures a record. Until the
   approval-proof format exists as a build, every seal this Action
   writes is a not-approved seal.
5. Sign: the workflow materialises the sealing key from the
   repository secret into a mode-600 temporary file, the run signs,
   and an always-run step destroys the file. The key is never
   logged, never cached, and never present on pull-request runs,
   which use an ephemeral key generated in memory.
6. Anchor when a command is configured. Failure after the retry
   budget publishes the seal with `anchor: null` and updates a
   tracking issue labelled `seal-anchor-pending`, unless the
   surface set `anchor.required`.
7. Commit back: one commit by the automation identity containing
   only the seals directory. Loop prevention is two-layered: the
   caller trigger ignores the seals directory, and the reusable
   workflow refuses to run when the head commit message starts
   with `seal:`.
8. Run summary: per item, hash, tier, anchor status, and skips
   with reasons, in the workflow summary and (on publish)
   `_seals/run-summary.json`.

The run never resolves or prints any human identifier; the
registration check happens at verify time, which keeps the raw
value out of CI entirely.
