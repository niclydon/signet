import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSeal, signedText } from "../src/seal.js";
import { verifySeal } from "../src/verify.js";
import { recoverMessageAddress } from "../src/wallet.js";
import {
  VISTO_PROOF_TYPE,
  vistoCanonicalHash,
  vistoRecordHash,
  checkVistoRecordSignature,
  approvalFromVistoRecord,
  recordBindsPayload,
  recordApproverMatches,
  createVistoApprovalService,
} from "../src/visto-approval.js";
import {
  TEST_ADDRESS_0,
  fixtureSealOptions,
  FIXTURE_CONTENT,
  registeredAgentBook,
} from "./helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/visto-record.json", import.meta.url), "utf8"));
const { record, trust } = fixture;

test("record hash and issuer signature verify against the fixture", () => {
  assert.equal(vistoRecordHash(record), fixture.record_hash);
  assert.equal(vistoCanonicalHash(fixture.payload), fixture.payload_hash);
  const checked = checkVistoRecordSignature(record, trust);
  assert.equal(checked.ok, true);
  assert.equal(checked.record_hash, fixture.record_hash);
});

test("tampered or mis-trusted records are refused", () => {
  const tampered = { ...record, approved_at: "2026-11-02T15:06:00Z" };
  assert.deepEqual(checkVistoRecordSignature(tampered, trust), { ok: false, reason: "signature_invalid" });
  assert.deepEqual(
    checkVistoRecordSignature(record, { issuer: "https://elsewhere.invalid", keys: trust.keys }),
    { ok: false, reason: "issuer_mismatch" },
  );
  assert.deepEqual(
    checkVistoRecordSignature(record, { issuer: trust.issuer, keys: {} }),
    { ok: false, reason: "signature_invalid" },
  );
  assert.deepEqual(checkVistoRecordSignature({ nope: true }, trust), { ok: false, reason: "record_malformed" });
});

test("approvalFromVistoRecord yields the seal claim and bindings", () => {
  const out = approvalFromVistoRecord(record, trust);
  assert.equal(out.ok, true);
  assert.deepEqual(out.approval, {
    proof_hash: fixture.record_hash,
    proof_type: VISTO_PROOF_TYPE,
    approved_at: record.approved_at,
  });
  assert.equal(recordBindsPayload(record, fixture.payload_hash), true);
  assert.equal(recordBindsPayload(record, "sha256:" + "0".repeat(64)), false);
  assert.equal(recordApproverMatches(record, record.human_id_hash), true);
  assert.equal(recordApproverMatches(record, "sha256:" + "0".repeat(64)), false);
});

test("an approved seal verifies when the service confirms the record", async () => {
  const { approval } = approvalFromVistoRecord(record, trust);
  const seal = createSeal(fixtureSealOptions({ approval }));
  assert.equal(seal.approval.tier, "approved");
  assert.equal(recoverMessageAddress(signedText(seal), seal.signature.value), TEST_ADDRESS_0);

  const confirmed = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    approvalService: { confirmApproval: async () => ({ confirmed: true, lastConfirmedAt: "2026-11-02T15:10:00Z" }) },
  });
  assert.equal(confirmed.checks.approval.status, "pass");
  assert.equal(confirmed.tier, "approved");
  assert.ok(!confirmed.failures.includes("approval-not-confirmed"));

  const denied = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    approvalService: { confirmApproval: async () => ({ confirmed: false }) },
  });
  assert.equal(denied.checks.approval.status, "fail");
  assert.ok(denied.failures.includes("approval-not-confirmed"));

  const noService = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
  });
  assert.equal(noService.checks.approval.status, "fail");
  assert.ok(noService.failures.includes("approval-not-confirmed"));
});

test("the reconfirm provider maps service states to the verify contract", async () => {
  const proofHash = "sha256:" + "e".repeat(64);
  const stub = (impl) => {
    const calls = [];
    const svc = createVistoApprovalService({
      baseUrl: "http://visto.test/",
      fetchImpl: async (url) => { calls.push(url); return impl(url); },
    });
    return { svc, calls };
  };

  const valid = stub(async () => ({ status: 200, json: async () => ({ status: "valid", consumed: true }) }));
  const ok = await valid.svc.confirmApproval({ proofHash, contentHash: "sha256:" + "a".repeat(64) });
  assert.equal(ok.confirmed, true);
  assert.equal(ok.consumed, true);
  assert.match(valid.calls[0], new RegExp("/v1/records/" + proofHash + "/reconfirm$"));

  const unknown = stub(async () => ({ status: 200, json: async () => ({ status: "unknown", consumed: false }) }));
  assert.equal((await unknown.svc.confirmApproval({ proofHash })).confirmed, false);

  const revoked = stub(async () => ({ status: 200, json: async () => ({ status: "revoked", consumed: false }) }));
  assert.equal((await revoked.svc.confirmApproval({ proofHash })).confirmed, false);

  const httpErr = stub(async () => ({ status: 503, json: async () => ({}) }));
  await assert.rejects(() => httpErr.svc.confirmApproval({ proofHash }));

  const netErr = createVistoApprovalService({
    baseUrl: "http://visto.test",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => netErr.confirmApproval({ proofHash }));
});
