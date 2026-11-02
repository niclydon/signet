// Sealing, per SPEC.md sections 4 and 5.
//
// Signed payload: the seal record minus its post-signing fields.
// The signed core is everything in the record except `signature`,
// plus two fields that are explicitly annotations added after
// signing and therefore excluded from the payload (this exclusion is
// structural, in code, and is what allows these fields to exist at
// all without invalidating the seal):
//   - timestamps.anchor (written by the follow-up anchor commit,
//     SPEC 9.2 step 6)
//   - superseded_by (written when a newer seal supersedes this one,
//     SPEC 4.1)
// The verifier validates those annotations against external sources
// (the chain, the seal index), never on the signature's authority.
//
// The approved tier (SPEC 5.2): createSeal writes tier
// "not-approved" by default. A caller may pass an approval claim
// ({ proof_hash, proof_type, approved_at }, normally produced by
// approvalFromVistoRecord in visto-approval.js from a W2
// approval-record/1), which createSeal validates in shape and then
// writes as tier "approved", inside the signed payload. The claim
// is only as good as the record behind it: verifySeal confirms it
// against the approval service at check time (SPEC 5.2 two-step),
// and a claim whose record cannot be confirmed fails as
// approval-not-confirmed. ApprovedTierDisabled is kept as a
// deprecated export from the interim build, when the tier was
// hard-disabled because no approval record existed yet.

import { C14N_ID, canonicalBytes, contentHash } from "./canonicalize.js";
import { canonicalJson, sha256Hex, sha256Prefixed, utf8 } from "./util.js";

export const SEAL_VERSION = "w3-seal/1";
export const SIGN_DOMAIN = "w3-provenance-seal:v1";

export class ApprovedTierDisabled extends Error {
  constructor(message = "deprecated: the human-approved tier is enabled; createSeal validates an approval claim's shape and writes it into the signed payload (SPEC 5.2)") {
    super(message);
    this.name = "ApprovedTierDisabled";
    this.code = "approved-tier-disabled";
  }
}

const ANNOTATION_PATHS = [
  ["timestamps", "anchor"],
  ["superseded_by"],
];

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The signed core of a seal record: the record with signature and annotation fields removed. */
export function sealCore(seal) {
  const core = deepClone(seal);
  delete core.signature;
  for (const path of ANNOTATION_PATHS) {
    let node = core;
    for (let i = 0; i < path.length - 1; i++) node = node?.[path[i]];
    if (node && typeof node === "object") node[path[path.length - 1]] = null;
  }
  if (core.timestamps && typeof core.timestamps === "object") {
    core.timestamps.sealed_at_basis = "signer-claimed";
  }
  return core;
}

/** SHA-256 over the canonical JSON of the signed core, in "sha256:..." form. */
export function payloadHash(seal) {
  return sha256Prefixed(utf8(canonicalJson(sealCore(seal))));
}

/** The exact text the sealing wallet signs (EIP-191), domain-separated per SPEC 4.2. */
export function signedText(seal) {
  return `${SIGN_DOMAIN} | ${seal.content.surface} | ${seal.content_hash} | ${payloadHash(seal)}`;
}

/**
 * Create a seal for a piece of text content.
 *
 * Required: content (string), surface, contentId, canonicalUrl,
 *   persona, signer (an object with .address and .signMessage).
 * Optional: title (hashed, never stored), sealedAt (ISO string;
 *   defaults to now), supersedes (content_hash of the prior seal),
 *   attachments ([{ name, bytes | sha256 }]).
 * Optional: approval ({ proof_hash, proof_type, approved_at })
 *   claims the human-approved tier; the shape is validated and the
 *   claim is signed into the seal. Omit it to seal as not-approved.
 */
export function createSeal(options) {
  const {
    content,
    surface,
    contentId,
    canonicalUrl,
    persona,
    signer,
    title = null,
    sealedAt = null,
    supersedes = null,
    attachments = [],
    approval = undefined,
  } = options ?? {};

  let approvalRecord = {
    tier: "not-approved",
    proof_hash: null,
    proof_type: null,
    approved_at: null,
  };
  if (approval !== undefined && approval !== null) {
    const { proof_hash, proof_type, approved_at } = approval ?? {};
    if (typeof proof_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(proof_hash)) {
      throw new TypeError("createSeal: approval.proof_hash must be a sha256: hash");
    }
    if (typeof proof_type !== "string" || proof_type.length === 0) {
      throw new TypeError("createSeal: approval.proof_type is required");
    }
    if (typeof approved_at !== "string" || Number.isNaN(Date.parse(approved_at))) {
      throw new TypeError("createSeal: approval.approved_at must be an ISO timestamp");
    }
    approvalRecord = { tier: "approved", proof_hash, proof_type, approved_at };
  }
  if (typeof content !== "string") throw new TypeError("createSeal: content must be a string");
  for (const [name, value] of Object.entries({ surface, contentId, canonicalUrl, persona })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`createSeal: ${name} is required`);
    }
  }
  if (!signer || typeof signer.signMessage !== "function" || typeof signer.address !== "string") {
    throw new TypeError("createSeal: signer must expose .address and .signMessage");
  }

  const hash = contentHash(content);
  const attachmentRecords = attachments.map((a) => {
    if (typeof a.name !== "string" || a.name.length === 0) {
      throw new TypeError("createSeal: attachment name is required");
    }
    const digest =
      a.sha256 ?? (a.bytes ? sha256Prefixed(a.bytes) : null);
    if (!digest) throw new TypeError("createSeal: attachment needs bytes or sha256");
    return { name: a.name, sha256: digest };
  });

  const seal = {
    seal_version: SEAL_VERSION,
    c14n: C14N_ID,
    content_hash: hash,
    content: {
      surface,
      content_id: contentId,
      canonical_url: canonicalUrl,
      title_hash: title == null ? null : sha256Prefixed(canonicalBytes(title)),
      attachments: attachmentRecords,
    },
    agent: {
      persona,
      wallet_address: signer.address,
      wallet_label: "the provenance sealing wallet",
    },
    signature: null,
    timestamps: {
      sealed_at: sealedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      sealed_at_basis: "signer-claimed",
      anchor: null,
    },
    approval: approvalRecord,
    supersedes,
    superseded_by: null,
  };

  const text = signedText(seal);
  seal.signature = {
    scheme: "eip191-personal-sign",
    signed_payload: text,
    value: signer.signMessage(text),
  };
  return seal;
}

/**
 * Return a copy of a seal with an anchor object attached (the
 * post-signing annotation the sealing workflow writes in its
 * follow-up commit, SPEC 9.2 step 6). The signed core is unchanged,
 * so the original signature still verifies.
 */
export function withAnchor(seal, anchor) {
  const copy = deepClone(seal);
  copy.timestamps.anchor = anchor;
  return copy;
}

/**
 * Return a copy of a seal annotated as superseded by a newer seal's
 * content hash. As with the anchor, this is an annotation outside
 * the signed core; the verifier confirms it against the index.
 */
export function withSupersededBy(seal, newerContentHash) {
  const copy = deepClone(seal);
  copy.superseded_by = newerContentHash;
  return copy;
}

export function _hashBytes(bytes) {
  return sha256Hex(bytes);
}
