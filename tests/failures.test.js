// Each of the eight named failure states in SPEC 7.1 / 7.3 is
// triggered by its own fixture here. A state that no fixture can
// trigger is a state the implementation does not actually have.

import test from "node:test";
import assert from "node:assert/strict";
import { createSeal, signedText, withAnchor, withSupersededBy } from "../src/seal.js";
import {
  FAILURE_STATES,
  humanIdHash,
  verifySeal,
  verifyByHash,
  MemorySealIndex,
} from "../src/verify.js";
import { MockLocalChain } from "../src/anchor.js";
import {
  FIXTURE_CONTENT,
  SYNTHETIC_HUMAN_ID,
  fixtureSealOptions,
  mockAgentBook,
  otherSigner,
  registeredAgentBook,
  throwingAgentBook,
} from "./helpers.js";

function resign(seal, signer) {
  const copy = JSON.parse(JSON.stringify(seal));
  const text = signedText(copy);
  copy.signature = {
    scheme: "eip191-personal-sign",
    signed_payload: text,
    value: signer.signMessage(text),
  };
  return copy;
}

test("FAILURE_STATES names exactly the eight states", () => {
  assert.deepEqual([...FAILURE_STATES], [
    "no-seal-found",
    "content-mismatch",
    "signature-mismatch",
    "wallet-not-registered",
    "seal-superseded",
    "approval-not-confirmed",
    "anchor-invalid",
    "check-incomplete",
  ]);
});

test("failure 1: no-seal-found", async () => {
  const result = await verifyByHash("sha256:" + "a".repeat(64), {
    sealIndex: new MemorySealIndex([]),
    agentBook: registeredAgentBook(),
  });
  assert.ok(result.failures.includes("no-seal-found"));
  assert.equal(result.state, "failed");
});

test("failure 2: content-mismatch (one character changed)", async () => {
  const seal = createSeal(fixtureSealOptions());
  const tampered = FIXTURE_CONTENT.replace("nothing", "nothlng");
  assert.notEqual(tampered, FIXTURE_CONTENT);
  const result = await verifySeal(seal, {
    content: tampered,
    agentBook: registeredAgentBook(),
  });
  assert.ok(result.failures.includes("content-mismatch"));
  assert.equal(result.checks.content.status, "fail");
});

test("failure 3: signature-mismatch (signed by the wrong wallet)", async () => {
  const seal = createSeal(fixtureSealOptions());
  const wrong = resign(seal, otherSigner());
  const result = await verifySeal(wrong, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
  });
  assert.ok(result.failures.includes("signature-mismatch"));
  assert.equal(result.checks.signature.status, "fail");
  assert.equal(result.checks.signature.recovered_address, otherSigner().address);
});

test("failure 4: wallet-not-registered", async () => {
  const seal = createSeal(fixtureSealOptions());
  const result = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: mockAgentBook({}),
  });
  assert.ok(result.failures.includes("wallet-not-registered"));
  assert.equal(result.checks.agentbook.status, "fail");
  assert.equal(result.checks.signature.status, "pass", "the two claims stay separate");
  assert.equal(result.human_id_hash, null);
});

test("failure 5: seal-superseded", async () => {
  const v1 = createSeal(fixtureSealOptions());
  const v2 = createSeal(
    fixtureSealOptions({
      content: FIXTURE_CONTENT + "An appended line changes the seal.\n",
      supersedes: v1.content_hash,
      sealedAt: "2026-10-26T05:00:00Z",
    }),
  );
  const v1Annotated = withSupersededBy(v1, v2.content_hash);
  const index = new MemorySealIndex([v1Annotated, v2]);
  const result = await verifyByHash(v1Annotated.content_hash, {
    sealIndex: index,
    agentBook: registeredAgentBook(),
    content: FIXTURE_CONTENT,
  });
  assert.ok(result.failures.includes("seal-superseded"));
  assert.equal(result.state, "verified-superseded");
  assert.equal(result.checks.seal.supersession_confirmed, true);
});

test("failure 6: approval-not-confirmed (an approved claim no record can confirm)", async () => {
  const seal = createSeal(fixtureSealOptions());
  const claiming = JSON.parse(JSON.stringify(seal));
  claiming.approval = {
    tier: "approved",
    proof_hash: "sha256:" + "b".repeat(64),
    proof_type: "world-id-presence-session-v1",
    approved_at: "2026-10-26T04:30:00Z",
  };
  const signedClaiming = resign(claiming, fixtureSealOptions().signer);
  const result = await verifySeal(signedClaiming, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    // No approvalService: W2's record does not exist yet, so no
    // approved claim can be confirmed in this build.
  });
  assert.ok(result.failures.includes("approval-not-confirmed"));
  assert.equal(result.checks.approval.status, "fail");
  assert.equal(result.checks.signature.status, "pass", "the seal itself is well-formed; only the approval claim fails");
});

test("failure 7: anchor-invalid (anchor transaction not found)", async () => {
  const chain = new MockLocalChain();
  const seal = createSeal(fixtureSealOptions());
  const anchor = await chain.anchorHash(seal.content_hash);
  const anchoredSeal = withAnchor(seal, anchor);
  const emptyChain = new MockLocalChain();
  const result = await verifySeal(anchoredSeal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    anchorChain: emptyChain,
  });
  assert.ok(result.failures.includes("anchor-invalid"));
  assert.equal(result.checks.anchor.status, "fail");
});

test("failure 8: check-incomplete (AgentBook provider error is not 'not registered')", async () => {
  const seal = createSeal(fixtureSealOptions());
  const result = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: throwingAgentBook(),
  });
  assert.ok(result.failures.includes("check-incomplete"));
  assert.ok(!result.failures.includes("wallet-not-registered"));
  assert.equal(result.checks.agentbook.status, "incomplete");
  assert.equal(result.state, "check-incomplete");
  assert.equal(result.checks.signature.status, "pass", "completed checks still report");
});

test("HUMANID RULE: the raw humanId never appears in a verify result", async () => {
  const seal = createSeal(fixtureSealOptions());
  const result = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SYNTHETIC_HUMAN_ID), "raw humanId leaked into the result");
  assert.equal(result.human_id_hash, humanIdHash(SYNTHETIC_HUMAN_ID));
  assert.equal(result.checks.agentbook.human_id_hash, result.human_id_hash);
});
