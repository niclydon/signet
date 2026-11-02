// Visto (W2) approval records, for the seal's human-approved tier
// (W3 SPEC 5.2). An approval-record/1 is a canonical-JSON document
// signed with Ed25519 by the approval service's issuer key. The
// seal stores only the record's hash (proof_hash), its type, and
// the approval time; the record itself stays with the approval
// service, so no session identifier or nullifier is published.
//
// Confirmation at verify time is the SPEC 5.2 two-step: the seal
// (signed by the sealing wallet) names the record's hash, and the
// approval service re-confirms that the record stands. The
// service's re-confirmation route is unprivileged and returns
// status only (W2 SPEC 8.5); the binding between a record and one
// exact content is established at seal time, where the full record
// is in hand: approvalFromVistoRecord verifies the issuer
// signature, and the caller checks the record's payload hash and
// approver hash against the content and the seal's human hash
// before createSeal is allowed to claim the tier.
//
// Canonicalisation: approval-record/1 hashes are RFC 8785 (JCS)
// canonical JSON, SHA-256, "sha256:"-prefixed. This library's
// canonicalJson is the same algorithm for the record's value
// domain (strings, integers, booleans, null, arrays, plain
// objects), which the interop fixtures in tests/ pin down.

import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalJson, sha256Prefixed, utf8 } from "./util.js";

export const VISTO_PROOF_TYPE = "visto-approval-record/1";
export const VISTO_RECORD_VERSION = "approval-record/1";

const HASH_REF = /^sha256:[a-f0-9]{64}$/;

/** RFC 8785 canonical hash of any JSON value, "sha256:"-prefixed. */
export function vistoCanonicalHash(value) {
  return sha256Prefixed(utf8(canonicalJson(value)));
}

/** The record hash that names an approval record: the canonical hash of the record body (everything but the signature). */
export function vistoRecordHash(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("vistoRecordHash: record must be an object");
  }
  const { signature, ...body } = record;
  return vistoCanonicalHash(body);
}

function base64urlToBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Verify an approval record's issuer signature against a trust
 * config of the same shape W2 uses: { issuer, keys }, where keys
 * maps a key id to the pinned Ed25519 public key's JWK x value
 * (base64url). Returns { ok: true, record, record_hash } or
 * { ok: false, reason } with reason one of "record_malformed",
 * "issuer_mismatch", "signature_invalid". This checks the
 * signature and the fields it relies on; W2's record module owns
 * the full record shape validation.
 */
export function checkVistoRecordSignature(record, trust) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "record_malformed" };
  }
  const sig = record.signature;
  if (
    record.record_version !== VISTO_RECORD_VERSION ||
    typeof record.issuer !== "string" ||
    !sig || typeof sig !== "object" ||
    sig.alg !== "ed25519" ||
    typeof sig.key_id !== "string" ||
    typeof sig.value !== "string"
  ) {
    return { ok: false, reason: "record_malformed" };
  }
  if (!trust || record.issuer !== trust.issuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }
  const x = trust.keys?.[sig.key_id];
  if (typeof x !== "string") return { ok: false, reason: "signature_invalid" };
  try {
    const { signature, ...body } = record;
    const valid = ed25519.verify(
      base64urlToBytes(sig.value),
      utf8(canonicalJson(body)),
      base64urlToBytes(x),
    );
    if (!valid) return { ok: false, reason: "signature_invalid" };
    return { ok: true, record, record_hash: vistoRecordHash(record) };
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
}

/**
 * The seal-time gate for the approved tier. Verifies the record's
 * signature and that it records an approval, then returns the
 * approval claim for createSeal plus the record fields the caller
 * must bind before sealing (payload_hash against the approved
 * payload's canonical hash, human_id_hash against the seal's
 * registered human hash, action_class against the action).
 */
export function approvalFromVistoRecord(record, trust) {
  const checked = checkVistoRecordSignature(record, trust);
  if (!checked.ok) return checked;
  if (record.decision !== "approved") return { ok: false, reason: "not_approved" };
  return {
    ok: true,
    record,
    record_hash: checked.record_hash,
    approval: {
      proof_hash: checked.record_hash,
      proof_type: VISTO_PROOF_TYPE,
      approved_at: record.approved_at,
    },
    payload_hash: record.payload_hash ?? null,
    action_class: record.action_class ?? null,
    human_id_hash: record.human_id_hash ?? null,
  };
}

/** True when the record approves exactly this payload (by its canonical hash). */
export function recordBindsPayload(record, payloadHash) {
  return typeof payloadHash === "string" && record?.payload_hash === payloadHash;
}

/** True when the record's approver is the human the seal's wallet is registered to. */
export function recordApproverMatches(record, humanIdHash) {
  return typeof humanIdHash === "string" && record?.human_id_hash === humanIdHash;
}

/**
 * An approvalService provider for verifySeal, backed by a Visto
 * approval service's unprivileged re-confirmation route. Status
 * "valid" confirms; "revoked" and "unknown" do not; any transport
 * or HTTP failure throws, which verifySeal reports as
 * check-incomplete (the SPEC 5.2 "approved, proof not re-checked
 * at this time" state), never as a fresh pass or a failure.
 */
export function createVistoApprovalService({ baseUrl, fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new TypeError("createVistoApprovalService: baseUrl is required");
  }
  const base = baseUrl.replace(/\/$/, "");
  return {
    async confirmApproval({ proofHash }) {
      if (!HASH_REF.test(proofHash ?? "")) return { confirmed: false, status: "unknown" };
      const res = await fetchImpl(`${base}/v1/records/${proofHash}/reconfirm`);
      if (!res || res.status !== 200) {
        throw new Error(`visto reconfirm failed: HTTP ${res?.status ?? "no response"}`);
      }
      const body = await res.json();
      if (body?.status === "valid") {
        return {
          confirmed: true,
          status: "valid",
          consumed: body.consumed ?? null,
          lastConfirmedAt: new Date().toISOString(),
        };
      }
      if (body?.status === "revoked" || body?.status === "unknown") {
        return { confirmed: false, status: body.status };
      }
      throw new Error("visto reconfirm failed: malformed response");
    },
  };
}
