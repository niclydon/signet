// The W0 adapter, against a fake verifier shaped exactly like
// @fiador/verify's VerifyResult (plus one test against an
// independent node:crypto computation of the canonical hash).
// Live-chain evidence for the real package is gathered separately
// by scripts/live-w0-check.mjs, not in this suite.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { w0AgentBookProvider } from "../src/agentbook-w0.js";
import { verifySeal, humanIdHash } from "../src/verify.js";
import { createSeal } from "../src/seal.js";
import {
  FIXTURE_CONTENT,
  SYNTHETIC_HUMAN_ID,
  TEST_ADDRESS_0,
  fixtureSealOptions,
} from "./helpers.js";

function w0Hash(raw) {
  // Independent of the W3 codebase: node:crypto straight on the
  // construction string, as W0's hash.ts defines it.
  return createHash("sha256").update(`w0-human-v1:${raw}`, "utf8").digest("hex");
}

function fakeVerifier(result) {
  return { async verifyAddress() { return result; } };
}

const W0_VERIFIED = {
  status: "verified",
  address: TEST_ADDRESS_0,
  addressTruncated: "0xf39F…2266",
  humanHash: w0Hash(SYNTHETIC_HUMAN_ID),
  failures: [],
  evidence: { checkedAt: "2026-10-26T09:00:00Z", source: "fixture", agentBook: { network: "eip155:480", contract: "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" } },
};

test("canonical hash: W3 humanIdHash matches the W0 construction computed independently", () => {
  assert.equal(humanIdHash(SYNTHETIC_HUMAN_ID), `sha256:${w0Hash(SYNTHETIC_HUMAN_ID)}`);
});

test("adapter maps W0 statuses onto the W3 provider contract", async () => {
  const provider = w0AgentBookProvider(fakeVerifier(W0_VERIFIED));
  assert.deepEqual(await provider.lookupHuman(TEST_ADDRESS_0), { humanHash: w0Hash(SYNTHETIC_HUMAN_ID) });

  const unregistered = w0AgentBookProvider(fakeVerifier({ ...W0_VERIFIED, status: "unregistered", humanHash: null, failures: ["not_registered"] }));
  assert.equal(await unregistered.lookupHuman(TEST_ADDRESS_0), null);

  const unknown = w0AgentBookProvider(fakeVerifier({ ...W0_VERIFIED, status: "unknown", humanHash: null, failures: ["lookup_failed"] }));
  await assert.rejects(() => unknown.lookupHuman(TEST_ADDRESS_0), /unknown/);
});

test("adapter validates its constructor argument", () => {
  assert.throws(() => w0AgentBookProvider(null), TypeError);
  assert.throws(() => w0AgentBookProvider({}), TypeError);
});

test("verifySeal through the adapter: raw-form and W0-form providers give identical results", async () => {
  const seal = createSeal(fixtureSealOptions());
  const viaW0 = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: w0AgentBookProvider(fakeVerifier(W0_VERIFIED)),
  });
  const viaRaw = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: { async lookupHuman() { return SYNTHETIC_HUMAN_ID; } },
  });
  assert.equal(viaW0.state, "verified");
  assert.equal(viaW0.checks.agentbook.status, "pass");
  assert.equal(viaW0.human_id_hash, `sha256:${w0Hash(SYNTHETIC_HUMAN_ID)}`);
  assert.equal(viaW0.human_id_hash, viaRaw.human_id_hash, "one human, one hash, whichever provider form supplied it");
  assert.ok(!JSON.stringify(viaW0).includes(SYNTHETIC_HUMAN_ID));
});

test("verifySeal through the adapter: W0 unknown becomes check-incomplete, never not-registered", async () => {
  const seal = createSeal(fixtureSealOptions());
  const result = await verifySeal(seal, {
    content: FIXTURE_CONTENT,
    agentBook: w0AgentBookProvider(fakeVerifier({ ...W0_VERIFIED, status: "unknown", humanHash: null, failures: ["lookup_timeout"] })),
  });
  assert.equal(result.checks.agentbook.status, "incomplete");
  assert.ok(result.failures.includes("check-incomplete"));
  assert.ok(!result.failures.includes("wallet-not-registered"));
});
