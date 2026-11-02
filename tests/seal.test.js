import test from "node:test";
import assert from "node:assert/strict";
import { createSeal, withAnchor, withSupersededBy } from "../src/seal.js";
import { verifySeal, MemorySealIndex } from "../src/verify.js";
import { MockLocalChain } from "../src/anchor.js";
import { recoverMessageAddress, privateKeyToAddress } from "../src/wallet.js";
import { signedText } from "../src/seal.js";
import {
  TEST_KEY_0,
  TEST_ADDRESS_0,
  fixtureSealOptions,
  FIXTURE_CONTENT,
  registeredAgentBook,
  testSigner,
} from "./helpers.js";

test("test key derives the known Hardhat account #0 address", () => {
  assert.equal(privateKeyToAddress(TEST_KEY_0), TEST_ADDRESS_0);
  assert.equal(testSigner().address, TEST_ADDRESS_0);
});

test("seal and verify round-trip passes", async () => {
  const seal = createSeal(fixtureSealOptions());
  assert.equal(seal.approval.tier, "not-approved");
  assert.equal(seal.timestamps.anchor, null);
  assert.match(seal.signature.value, /^0x[0-9a-f]{130}$/);

  const recovered = recoverMessageAddress(signedText(seal), seal.signature.value);
  assert.equal(recovered, TEST_ADDRESS_0);

  const result = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
  });
  assert.equal(result.schema, "w3-verify-result/1");
  assert.equal(result.state, "verified");
  assert.deepEqual(result.failures, []);
  assert.equal(result.checks.signature.status, "pass");
  assert.equal(result.checks.content.status, "pass");
  assert.equal(result.checks.agentbook.status, "pass");
  assert.equal(result.tier, "not-approved");
  assert.match(result.summary, /Human approved: no/);
});

test("sealing identical content twice is deterministic except sealed_at input", () => {
  const a = createSeal(fixtureSealOptions());
  const b = createSeal(fixtureSealOptions());
  assert.deepEqual(a, b);
});

test("approved tier writes a validated claim into the signed payload", () => {
  const approval = {
    proof_hash: "sha256:" + "1".repeat(64),
    proof_type: "visto-approval-record/1",
    approved_at: "2026-11-02T15:05:00Z",
  };
  const seal = createSeal(fixtureSealOptions({ approval }));
  assert.equal(seal.approval.tier, "approved");
  assert.equal(seal.approval.proof_hash, approval.proof_hash);
  assert.equal(seal.approval.proof_type, approval.proof_type);
  assert.equal(seal.approval.approved_at, approval.approved_at);
  assert.equal(recoverMessageAddress(signedText(seal), seal.signature.value), TEST_ADDRESS_0);
});

test("approved tier refuses malformed claims", () => {
  const base = {
    proof_hash: "sha256:" + "1".repeat(64),
    proof_type: "visto-approval-record/1",
    approved_at: "2026-11-02T15:05:00Z",
  };
  assert.throws(() => createSeal(fixtureSealOptions({ approval: { ...base, proof_hash: "sha256:zz" } })), TypeError);
  assert.throws(() => createSeal(fixtureSealOptions({ approval: { ...base, proof_type: "" } })), TypeError);
  assert.throws(() => createSeal(fixtureSealOptions({ approval: { ...base, approved_at: "not a date" } })), TypeError);
  assert.throws(() => createSeal(fixtureSealOptions({ approval: { tier: "approved", proofHash: base.proof_hash } })), TypeError);
});

test("anchor annotation does not break the signature, and verifies against the mock chain", async () => {
  const chain = new MockLocalChain();
  const seal = createSeal(fixtureSealOptions());
  const anchor = await chain.anchorHash(seal.content_hash);
  chain.mineBlock();
  chain.mineBlock();
  const anchoredSeal = withAnchor(seal, anchor);

  const result = await verifySeal(anchoredSeal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    anchorChain: chain,
    requiredConfirmations: 2,
  });
  assert.equal(result.checks.signature.status, "pass", "annotation must not invalidate the signed core");
  assert.equal(result.checks.anchor.status, "pass");
  assert.equal(result.timing.basis, "world-chain-anchor");
  assert.match(result.summary, /anchored on World Chain/);
});

test("superseded annotation does not break the signature", async () => {
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
  const result = await verifySeal(v1Annotated, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    sealIndex: index,
  });
  assert.equal(result.checks.signature.status, "pass");
  assert.equal(result.disposition, "superseded");
});
