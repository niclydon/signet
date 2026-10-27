// Tests for the GitHub Action sealing run (action/seal-run.mjs),
// covering the SPEC 9 postures: idempotent re-runs, supersession,
// PR dry runs on an ephemeral key only, canonicalisation failing
// closed, the approval gate, anchor fail-open with disclosure, and
// anchor-required failing closed with nothing published.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { runSealing, isSealCommit, ephemeralSigner } from "../action/seal-run.mjs";
import { PrivateKeySigner } from "../src/wallet.js";
import { contentHash } from "../src/canonicalize.js";
import { verifySeal } from "../src/verify.js";

const REAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const REAL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const BASE_CONFIG = {
  surface: "personal-website",
  persona: "Fixture Agent",
  canonicalUrlBase: "https://example.com/",
  content: ["posts/**"],
  exclude: ["posts/drafts/**"],
  hashScope: "file",
  sealsDir: "_seals",
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "signet-action-"));
  await mkdir(join(root, "posts"), { recursive: true });
  return root;
}

async function put(root, rel, text) {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, text);
}

const POST = "Hello, sealed world.\n";

test("publish seals a new file, and the seal verifies offline", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const out = await runSealing({ root, config: BASE_CONFIG, signer: new PrivateKeySigner(REAL_KEY) });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, "sealed");
  const seal = JSON.parse(await readFile(join(root, "_seals/posts/a.md.json"), "utf8"));
  assert.equal(seal.agent.wallet_address, REAL_ADDRESS);
  const checked = await verifySeal(seal, {
    content: POST,
    agentBook: { async lookupHuman() { return null; } },
  });
  assert.equal(checked.checks.signature.status, "pass");
  const index = JSON.parse(await readFile(join(root, "_seals/index.json"), "utf8"));
  assert.equal(index.seals["posts/a.md"].content_hash, contentHash(POST));
});

test("re-run is idempotent: no new seal, explicit skip", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const signer = new PrivateKeySigner(REAL_KEY);
  await runSealing({ root, config: BASE_CONFIG, signer });
  const out = await runSealing({ root, config: BASE_CONFIG, signer });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, "skipped");
  const sealFiles = (await readdir(join(root, "_seals/posts"))).filter((f) => f.endsWith(".json"));
  assert.equal(sealFiles.length, 1);
});

test("changed content produces a new seal that supersedes the old hash", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const signer = new PrivateKeySigner(REAL_KEY);
  await runSealing({ root, config: BASE_CONFIG, signer });
  await put(root, "posts/a.md", "Hello, edited world.\n");
  const out = await runSealing({ root, config: BASE_CONFIG, signer });
  assert.equal(out.results[0].status, "sealed");
  assert.equal(out.results[0].supersedes, contentHash(POST));
  const seal = JSON.parse(await readFile(join(root, "_seals/posts/a.md.json"), "utf8"));
  assert.equal(seal.supersedes, contentHash(POST));
});

test("non-canonical content fails closed and publishes nothing", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", "CRLF line endings\r\nbreak canonical form\r\n");
  await put(root, "posts/b.md", POST);
  const out = await runSealing({ root, config: BASE_CONFIG, signer: new PrivateKeySigner(REAL_KEY) });
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(root, "_seals")), false, "a failed run writes no seals at all");
});

test("dry run uses an ephemeral key, writes nothing, and is labelled a dry run", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const out = await runSealing({ root, config: BASE_CONFIG, mode: "dry-run", signer: new PrivateKeySigner(REAL_KEY) });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, "dry-run");
  assert.notEqual(out.results[0].signerAddress, REAL_ADDRESS);
  assert.equal(existsSync(join(root, "_seals")), false);
  assert.match(out.summaryMarkdown, /dry run, unrecorded/i);
});

test("excluded paths are never sealed", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  await put(root, "posts/drafts/secret.md", POST);
  const out = await runSealing({ root, config: BASE_CONFIG, signer: new PrivateKeySigner(REAL_KEY) });
  assert.deepEqual(out.results.map((r) => r.file), ["posts/a.md"]);
});

test("approval gate: required with no record fails closed; fallback publishes as not approved", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const signer = new PrivateKeySigner(REAL_KEY);
  const strict = { ...BASE_CONFIG, approval: { required: true, fallback: "fail" } };
  const blocked = await runSealing({ root, config: strict, signer });
  assert.equal(blocked.ok, false);
  assert.equal(existsSync(join(root, "_seals")), false);

  const lenient = { ...BASE_CONFIG, approval: { required: true, fallback: "not-approved" } };
  const published = await runSealing({ root, config: lenient, signer });
  assert.equal(published.ok, true);
  assert.equal(published.results[0].tier, "not-approved");
  assert.match(published.results[0].approvalNote, /published as not approved/);
});

test("approval gate: a confirmed record for the hash opens publication", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const hash = contentHash(POST);
  await put(root, `_approvals/${hash.slice("sha256:".length)}.json`, JSON.stringify({ content_hash: hash, confirmed: true }));
  const config = { ...BASE_CONFIG, approval: { required: true, fallback: "fail", recordsDir: "_approvals" } };
  const out = await runSealing({ root, config, signer: new PrivateKeySigner(REAL_KEY) });
  assert.equal(out.ok, true);
  assert.match(out.results[0].approvalNote, /confirmed approval record present/);
});

test("anchor failure publishes unanchored with a pending entry (fail-open, disclosed)", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const failing = async () => { throw new Error("rpc unreachable"); };
  const out = await runSealing({ root, config: BASE_CONFIG, signer: new PrivateKeySigner(REAL_KEY), anchorFn: failing });
  assert.equal(out.ok, true);
  assert.equal(out.anchorPending.length, 1);
  const seal = JSON.parse(await readFile(join(root, "_seals/posts/a.md.json"), "utf8"));
  assert.equal(seal.timestamps.anchor, null);
  const pending = JSON.parse(await readFile(join(root, "_seals/anchor-pending.json"), "utf8"));
  assert.equal(pending[0].content_hash, contentHash(POST));
});

test("anchor-required failure fails closed and publishes nothing", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const failing = async () => { throw new Error("rpc unreachable"); };
  const config = { ...BASE_CONFIG, anchor: { required: true, retries: 2 } };
  const out = await runSealing({ root, config, signer: new PrivateKeySigner(REAL_KEY), anchorFn: failing });
  assert.equal(out.ok, false);
  assert.equal(existsSync(join(root, "_seals")), false);
});

test("a successful anchor is recorded on the seal", async () => {
  const root = await fixtureRoot();
  await put(root, "posts/a.md", POST);
  const writer = async () => ({ chain: "eip155:480", tx_hash: "0xabc", submitted_hash: contentHash(POST) });
  // withAnchor recomputes the payload hash; the writer's anchor is
  // attached as recorded by the anchor layer.
  const out = await runSealing({ root, config: BASE_CONFIG, signer: new PrivateKeySigner(REAL_KEY), anchorFn: writer });
  assert.equal(out.ok, true);
  const seal = JSON.parse(await readFile(join(root, "_seals/posts/a.md.json"), "utf8"));
  assert.equal(seal.timestamps.anchor.tx_hash, "0xabc");
});

test("commit-back loop guard recognises seal commits", () => {
  assert.equal(isSealCommit("seal: posts/a.md (0123abcd…wxyz)"), true);
  assert.equal(isSealCommit("posts: new article"), false);
  assert.equal(isSealCommit(null), false);
});
