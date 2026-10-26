import test from "node:test";
import assert from "node:assert/strict";
import {
  MockLocalChain,
  WorldChainAnchorProvider,
  AnchorNotConfigured,
  anchorCalldata,
} from "../src/anchor.js";
import { createSeal, withAnchor } from "../src/seal.js";
import { verifySeal } from "../src/verify.js";
import { fixtureSealOptions, FIXTURE_CONTENT, registeredAgentBook } from "./helpers.js";

test("anchorCalldata carries exactly the 32 hash bytes", () => {
  const hash = "sha256:" + "ab".repeat(32);
  assert.equal(anchorCalldata(hash), "0x" + "ab".repeat(32));
  assert.throws(() => anchorCalldata("sha256:abcd"), /32-byte/);
});

test("mock chain: anchor write then read-back with confirmations", async () => {
  const chain = new MockLocalChain();
  const hash = "sha256:" + "cd".repeat(32);
  const anchor = await chain.anchorHash(hash);
  assert.equal(anchor.chain, "eip155:480");
  assert.equal(anchor.anchored_hash, hash);
  const seen = await chain.getAnchor(anchor.tx_hash);
  assert.equal(seen.anchoredHash, hash);
  assert.equal(seen.confirmations, 1);
  chain.mineBlock();
  const seenLater = await chain.getAnchor(anchor.tx_hash);
  assert.equal(seenLater.confirmations, 2);
  assert.equal(await chain.getAnchor("0x" + "00".repeat(32)), null);
});

test("world chain provider refuses to write while unconfigured (stacked, unfunded by design)", async () => {
  const provider = new WorldChainAnchorProvider();
  await assert.rejects(
    () => provider.anchorHash("sha256:" + "ef".repeat(32)),
    (err) => err instanceof AnchorNotConfigured && err.code === "anchor-not-configured",
  );
  await assert.rejects(() => provider.getAnchor("0x" + "00".repeat(32)), AnchorNotConfigured);
});

test("world chain provider works through injected writer/reader functions (interface shape)", async () => {
  const chain = new MockLocalChain();
  const provider = new WorldChainAnchorProvider({
    writer: async ({ data }) => {
      // The injected writer is the only part that would ever touch
      // the real chain; here it forwards to the mock chain.
      const written = await chain.anchorHash("sha256:" + data.slice(2));
      return written.tx_hash;
    },
    reader: (txHash) => chain.getAnchor(txHash),
  });
  const hash = "sha256:" + "12".repeat(32);
  const anchor = await provider.anchorHash(hash, { from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" });
  assert.equal(anchor.anchored_hash, hash);
  const seen = await provider.getAnchor(anchor.tx_hash);
  assert.equal(seen.anchoredHash, hash);
});

test("an unconfigured world provider surfaces in verification as check-incomplete, never a pass", async () => {
  const chain = new MockLocalChain();
  const seal = createSeal(fixtureSealOptions());
  const anchor = await chain.anchorHash(seal.content_hash);
  const anchoredSeal = withAnchor(seal, anchor);
  const result = await verifySeal(anchoredSeal, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    anchorChain: new WorldChainAnchorProvider(),
  });
  assert.equal(result.checks.anchor.status, "incomplete");
  assert.ok(result.failures.includes("check-incomplete"));
  assert.ok(!result.failures.includes("anchor-invalid"));
});

test("anchor hash mismatch is anchor-invalid", async () => {
  const chain = new MockLocalChain();
  const seal = createSeal(fixtureSealOptions());
  const otherAnchor = await chain.anchorHash("sha256:" + "99".repeat(32));
  const mismatched = withAnchor(seal, { ...otherAnchor, anchored_hash: seal.content_hash });
  // The seal claims the other transaction anchors this hash; the
  // chain record disagrees.
  const result = await verifySeal(mismatched, {
    content: FIXTURE_CONTENT,
    agentBook: registeredAgentBook(),
    anchorChain: chain,
  });
  assert.ok(result.failures.includes("anchor-invalid"));
  assert.match(result.checks.anchor.detail, /does not match/);
});
