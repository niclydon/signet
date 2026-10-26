// Verification, per SPEC.md section 7. verifySeal runs the checks
// as separate steps and returns a w3-verify-result/1 document; the
// eight named failure states are never collapsed into a generic
// "invalid", and a check that could not run reports as
// check-incomplete, distinct from a check that ran and failed.
//
// External systems sit behind injected interfaces, so everything
// here is provable offline:
//   agentBook:  async lookupHuman(walletAddress) -> lookup | null
//               (may throw on RPC failure). A lookup is either the
//               raw humanId string (internal/test providers only:
//               hashed in this module, immediately, and never
//               appearing in the result, THE HUMANID RULE, SPEC 2 /
//               4.3 / 7.2) or a precomputed hash object
//               { humanHash: "<hex>" } as returned by the W0 verify
//               core, whose public shape never carries the raw
//               value at all (see src/agentbook-w0.js).
//   anchorChain: async getAnchor(txHash) -> anchor record | null
//               (may throw). Absent provider + a seal claiming an
//               anchor = check-incomplete for that check.
//   approvalService: async confirmApproval({ proofHash, contentHash })
//               -> { confirmed: boolean, lastConfirmedAt: string|null }
//               Absent provider (the current build: W2 does not exist
//               yet) means any approved-tier claim is unconfirmable.
//   sealIndex: async lookupSeal(contentHash) -> seal | null
//               (used to confirm a superseded_by annotation and by
//               verifyByHash to find seals in the first place).

import { contentHash } from "./canonicalize.js";
import { payloadHash, signedText } from "./seal.js";
import { recoverMessageAddress } from "./wallet.js";
import { sha256Prefixed, utf8 } from "./util.js";

export const VERIFY_RESULT_SCHEMA = "w3-verify-result/1";

export const FAILURE_STATES = Object.freeze([
  "no-seal-found",
  "content-mismatch",
  "signature-mismatch",
  "wallet-not-registered",
  "seal-superseded",
  "approval-not-confirmed",
  "anchor-invalid",
  "check-incomplete",
]);

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The program-canonical human hash (W0 SPEC 3.5, frozen for v1):
 * SHA-256 of the domain-separated string "w0-human-v1:<humanId>".
 * W3 adopted this construction on Oct 26, 2026, superseding the
 * plain-hash reading of the W3 spec, so that one human carries one
 * hash on every program surface (badges, attestations, seals).
 * Returned in W3's record form, "sha256:<hex>".
 */
export function humanIdHash(rawHumanId) {
  return sha256Prefixed(utf8(`w0-human-v1:${String(rawHumanId)}`));
}

function normalizeLookupHash(found) {
  if (typeof found === "string") return humanIdHash(found);
  if (found && typeof found === "object") {
    const hex =
      typeof found.humanHash === "string"
        ? found.humanHash.replace(/^sha256:/, "")
        : typeof found.human_id_hash === "string"
          ? found.human_id_hash.replace(/^sha256:/, "")
          : null;
    if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return `sha256:${hex.toLowerCase()}`;
  }
  throw new Error("AgentBook provider returned an unrecognised lookup result");
}

function baseResult(contentHashValue, checkedAt) {
  return {
    schema: VERIFY_RESULT_SCHEMA,
    content_hash: contentHashValue ?? null,
    checked_at: checkedAt,
    state: "check-incomplete",
    disposition: "current",
    failures: [],
    checks: {
      seal: { status: "not-run" },
      signature: { status: "not-run" },
      content: { status: "not-run" },
      agentbook: { status: "not-run" },
      anchor: { status: "not-run" },
      approval: { status: "not-run" },
    },
    agent: null,
    tier: null,
    timing: null,
    human_id_hash: null,
    summary: "",
  };
}

function addFailure(result, code) {
  if (!result.failures.includes(code)) result.failures.push(code);
}

function finish(result, seal) {
  const hardFailures = result.failures.filter(
    (f) => f !== "seal-superseded" && f !== "check-incomplete",
  );
  if (result.failures.includes("seal-superseded")) result.disposition = "superseded";
  if (hardFailures.length > 0) {
    result.state = "failed";
  } else if (result.failures.includes("check-incomplete")) {
    result.state = "check-incomplete";
  } else {
    result.state = result.disposition === "superseded" ? "verified-superseded" : "verified";
  }
  result.summary = buildSummary(result, seal);
  return result;
}

function buildSummary(result, seal) {
  if (result.failures.includes("no-seal-found")) {
    return "No seal found for this hash in the index searched.";
  }
  const parts = [];
  const sig = result.checks.signature.status;
  const book = result.checks.agentbook.status;
  if (sig === "pass" && book === "pass") {
    parts.push("agent wallet signed this exact content");
    parts.push(`wallet registered to a unique human (checked ${result.checked_at})`);
  } else if (sig === "pass") {
    parts.push("agent wallet signed this exact content");
    parts.push("wallet registration could not be confirmed as passing");
  } else {
    parts.push("the seal's signature does not verify for this content");
  }
  if (result.checks.content.status === "fail") {
    parts.push("the supplied content does not match the sealed hash");
  }
  if (result.tier === "approved") {
    parts.push(
      result.checks.approval.status === "pass"
        ? "Human approved: yes, proof recorded"
        : "Human approved: claimed, proof not confirmed",
    );
  } else if (result.tier === "not-approved") {
    parts.push("Human approved: no");
  }
  if (result.timing?.basis === "world-chain-anchor" && result.checks.anchor.status === "pass") {
    parts.push(`Timing: anchored on World Chain at ${result.timing.anchor.block_timestamp}`);
  } else if (seal) {
    parts.push("Timing: signer-claimed, not anchored");
  }
  if (result.disposition === "superseded") {
    parts.push("This seal has been superseded by a newer seal");
  }
  const line = parts.join(". ");
  return line ? line + "." : "Verification did not complete.";
}

/**
 * Verify one seal record. `content` is optional; when supplied, its
 * canonical hash is recomputed and compared. Returns a
 * w3-verify-result/1 object; never throws for a verification
 * failure (failures are data). Throws only on programmer error.
 */
export async function verifySeal(seal, options = {}) {
  const {
    content = null,
    agentBook = null,
    anchorChain = null,
    approvalService = null,
    sealIndex = null,
    requiredConfirmations = 1,
    checkedAt = nowIso(),
  } = options;

  const result = baseResult(seal?.content_hash ?? null, checkedAt);

  // Check 1, seal consistency (SPEC 7.2 step 1).
  if (!seal || typeof seal !== "object") {
    addFailure(result, "no-seal-found");
    result.checks.seal = { status: "fail", detail: "no seal record supplied" };
    return finish(result, null);
  }
  result.agent = {
    persona: seal.agent?.persona ?? null,
    wallet_address: seal.agent?.wallet_address ?? null,
  };
  result.tier = seal.approval?.tier ?? null;
  result.timing = {
    sealed_at: seal.timestamps?.sealed_at ?? null,
    basis: seal.timestamps?.anchor ? "world-chain-anchor" : "signer-claimed",
    anchor: seal.timestamps?.anchor ?? null,
  };

  let sealConsistent = true;
  const problems = [];
  if (seal.seal_version !== "w3-seal/1") {
    sealConsistent = false;
    problems.push(`unknown seal_version ${JSON.stringify(seal.seal_version)}`);
  }
  if (seal.c14n !== "w3-text-v1") {
    sealConsistent = false;
    problems.push(`unknown c14n ${JSON.stringify(seal.c14n)}`);
  }
  if (!seal.signature || typeof seal.signature.value !== "string") {
    sealConsistent = false;
    problems.push("seal carries no signature");
  }
  result.checks.seal = sealConsistent
    ? { status: "pass", payload_hash: payloadHash(seal) }
    : { status: "fail", detail: problems.join("; ") };
  if (!sealConsistent) {
    // Without a consistent seal, downstream checks would be noise.
    addFailure(result, "check-incomplete");
    return finish(result, seal);
  }

  // Check 2, content match (SPEC 7.2 step 3), when content supplied.
  if (content != null) {
    const recomputed = contentHash(content);
    if (recomputed === seal.content_hash) {
      result.checks.content = { status: "pass", recomputed_hash: recomputed };
    } else {
      result.checks.content = { status: "fail", recomputed_hash: recomputed };
      addFailure(result, "content-mismatch");
    }
  } else {
    result.checks.content = { status: "skipped", detail: "no content supplied" };
  }

  // Check 3, signature (SPEC 7.2 step 2).
  try {
    const expected = signedText(seal);
    if (seal.signature.signed_payload !== expected) {
      result.checks.signature = {
        status: "fail",
        detail: "signed_payload does not match the payload reconstructed from the seal",
      };
      addFailure(result, "signature-mismatch");
    } else {
      const recovered = recoverMessageAddress(expected, seal.signature.value);
      if (recovered.toLowerCase() === String(seal.agent?.wallet_address ?? "").toLowerCase()) {
        result.checks.signature = { status: "pass", recovered_address: recovered };
      } else {
        result.checks.signature = {
          status: "fail",
          recovered_address: recovered,
          detail: "signature recovers to a different address than the seal's wallet",
        };
        addFailure(result, "signature-mismatch");
      }
    }
  } catch (err) {
    result.checks.signature = { status: "fail", detail: `signature recovery error: ${err.message}` };
    addFailure(result, "signature-mismatch");
  }

  // Check 4, AgentBook registration, live through the injected
  // provider (SPEC 7.2 step 4). HUMANID RULE: the raw humanId is
  // hashed here and never copied into the result, a log, or an
  // error message.
  if (!agentBook || typeof agentBook.lookupHuman !== "function") {
    result.checks.agentbook = { status: "incomplete", detail: "no AgentBook provider configured" };
    addFailure(result, "check-incomplete");
  } else {
    try {
      const found = await agentBook.lookupHuman(seal.agent.wallet_address);
      if (found == null) {
        result.checks.agentbook = { status: "fail", detail: "wallet not registered at check time" };
        addFailure(result, "wallet-not-registered");
      } else {
        result.human_id_hash = normalizeLookupHash(found);
        result.checks.agentbook = {
          status: "pass",
          registered: true,
          human_id_hash: result.human_id_hash,
        };
      }
    } catch (err) {
      result.checks.agentbook = {
        status: "incomplete",
        detail: "AgentBook check failed at this time (provider error)",
      };
      addFailure(result, "check-incomplete");
    }
  }

  // Check 5, anchor (SPEC 7.2 step 5). No anchor on the seal is a
  // disclosed limitation (timing stays signer-claimed), not a
  // failure; a claimed anchor that does not check out is.
  const anchor = seal.timestamps?.anchor ?? null;
  if (!anchor) {
    result.checks.anchor = { status: "skipped", detail: "seal is not anchored; timing is signer-claimed" };
  } else if (!anchorChain || typeof anchorChain.getAnchor !== "function") {
    result.checks.anchor = { status: "incomplete", detail: "no anchor chain provider configured" };
    addFailure(result, "check-incomplete");
  } else {
    try {
      const seen = await anchorChain.getAnchor(anchor.tx_hash);
      if (!seen) {
        result.checks.anchor = { status: "fail", detail: "anchor transaction not found" };
        addFailure(result, "anchor-invalid");
      } else if (seen.anchoredHash !== seal.content_hash) {
        result.checks.anchor = { status: "fail", detail: "anchored hash does not match the content hash" };
        addFailure(result, "anchor-invalid");
      } else if ((seen.confirmations ?? 0) < requiredConfirmations) {
        result.checks.anchor = {
          status: "fail",
          detail: `anchor has ${seen.confirmations ?? 0} confirmations, below the required ${requiredConfirmations}`,
        };
        addFailure(result, "anchor-invalid");
      } else {
        result.checks.anchor = {
          status: "pass",
          block_number: seen.blockNumber,
          block_timestamp: seen.blockTimestamp,
          confirmations: seen.confirmations,
        };
        result.timing.anchor = {
          ...anchor,
          block_number: seen.blockNumber,
          block_timestamp: seen.blockTimestamp,
        };
      }
    } catch (err) {
      result.checks.anchor = { status: "incomplete", detail: "anchor check failed at this time (provider error)" };
      addFailure(result, "check-incomplete");
    }
  }

  // Check 6, approval (SPEC 7.2 step 6 and 5.2). The not-approved
  // tier is a pass by definition (the seal claims nothing); an
  // approved claim must be confirmed against the approval service,
  // and in this build there is none, so it cannot confirm.
  if (seal.approval?.tier === "not-approved") {
    result.checks.approval = { status: "pass", detail: "seal claims no human approval" };
  } else if (seal.approval?.tier === "approved") {
    if (!approvalService || typeof approvalService.confirmApproval !== "function") {
      result.checks.approval = {
        status: "fail",
        detail: "approved tier claimed, but no approval record service exists to confirm it (tier is hard-disabled in this build)",
      };
      addFailure(result, "approval-not-confirmed");
    } else {
      try {
        const confirmation = await approvalService.confirmApproval({
          proofHash: seal.approval.proof_hash,
          contentHash: seal.content_hash,
        });
        if (confirmation?.confirmed) {
          result.checks.approval = {
            status: "pass",
            proof_type: seal.approval.proof_type ?? null,
            approved_at: seal.approval.approved_at ?? null,
            last_confirmed_at: confirmation.lastConfirmedAt ?? checkedAt,
          };
        } else {
          result.checks.approval = { status: "fail", detail: "approval record does not confirm this content hash" };
          addFailure(result, "approval-not-confirmed");
        }
      } catch (err) {
        result.checks.approval = { status: "incomplete", detail: "approval service unreachable at this time" };
        addFailure(result, "check-incomplete");
      }
    }
  } else {
    result.checks.approval = { status: "fail", detail: `unknown approval tier ${JSON.stringify(seal.approval?.tier)}` };
    addFailure(result, "approval-not-confirmed");
  }

  // Check 7, supersession (SPEC 4.1 / 7.3). The annotation on the
  // seal is a claim; when an index is available, confirm the newer
  // seal exists and points back. Superseded is a disposition, not
  // an invalidation: the old seal's own checks still report above.
  if (seal.superseded_by) {
    let confirmed = false;
    if (sealIndex && typeof sealIndex.lookupSeal === "function") {
      try {
        const newer = await sealIndex.lookupSeal(seal.superseded_by);
        confirmed = Boolean(newer && newer.supersedes === seal.content_hash);
      } catch (err) {
        result.checks.seal = {
          ...result.checks.seal,
          supersession: "index lookup failed; annotation unconfirmed",
        };
        addFailure(result, "check-incomplete");
      }
    }
    result.checks.seal = {
      ...result.checks.seal,
      superseded_by: seal.superseded_by,
      supersession_confirmed: confirmed,
    };
    addFailure(result, "seal-superseded");
  }

  return finish(result, seal);
}

/**
 * Look a seal up by content hash in an index and verify it. A hash
 * with no seal in the index produces the no-seal-found state.
 */
export async function verifyByHash(hash, options = {}) {
  const { sealIndex, checkedAt = nowIso(), ...rest } = options;
  if (!sealIndex || typeof sealIndex.lookupSeal !== "function") {
    throw new TypeError("verifyByHash: sealIndex with lookupSeal is required");
  }
  let seal = null;
  try {
    seal = await sealIndex.lookupSeal(hash);
  } catch (err) {
    const result = baseResult(hash, checkedAt);
    result.checks.seal = { status: "incomplete", detail: "seal index unreachable at this time" };
    addFailure(result, "check-incomplete");
    return finish(result, null);
  }
  if (!seal) {
    const result = baseResult(hash, checkedAt);
    result.checks.seal = { status: "fail", detail: "no seal found for this hash in the index searched" };
    addFailure(result, "no-seal-found");
    return finish(result, null);
  }
  return verifySeal(seal, { sealIndex, checkedAt, ...rest });
}

/** Simple in-memory seal index: the reference lookupSeal provider. */
export class MemorySealIndex {
  constructor(seals = []) {
    this.byHash = new Map(seals.map((s) => [s.content_hash, s]));
  }
  add(seal) {
    this.byHash.set(seal.content_hash, seal);
    return seal;
  }
  async lookupSeal(hash) {
    return this.byHash.get(hash) ?? null;
  }
}
