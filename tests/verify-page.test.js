// Tests for the verify page's live providers (browser-providers.js)
// and for verifySeal running on top of them. Everything is driven
// through a stubbed fetch implementing just the JSON-RPC methods
// the providers call, so the page's exact check logic is proven
// offline, including its failure honesty: an RPC failure must come
// back check-incomplete, never wallet-not-registered.

import test from "node:test";
import assert from "node:assert/strict";

import { createSeal, withAnchor } from "../src/seal.js";
import { PrivateKeySigner } from "../src/wallet.js";
import { verifySeal } from "../src/verify.js";
import {
  createBrowserAgentBook,
  createBrowserAnchorChain,
  AGENTBOOK_CONTRACT,
} from "../verify/browser-providers.js";

const HARDHAT_TEST_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const signer = new PrivateKeySigner(HARDHAT_TEST_KEY_0);
const CONTENT = "# Sample\n\nText sealed for the provider tests.\n";
const seal = createSeal({
  content: CONTENT,
  surface: "web",
  contentId: "provider-test-post",
  canonicalUrl: "https://example.invalid/provider-test-post",
  persona: "signet-test",
  signer,
  sealedAt: "2026-10-26T00:00:00Z",
});

// sha256("w0-human-v1:0x01"), computed independently with Python
// hashlib when this test was written, so the JS string form the
// provider returns ("0x01", viem toHex of uint256 1) is pinned
// against a second implementation, not against itself.
const EXPECTED_HASH_FOR_UINT256_1 =
  "sha256:bcacbaf197ac665263d0e8252dfb325d1238b83c73b860c5cce726362bdc9628";

function stubFetch(handlers) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const handler = handlers[body.method];
    if (!handler) throw new Error(`stub: unexpected method ${body.method}`);
    const result = await handler(body.params);
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: body.id, result };
      },
    };
  };
}

function agentBookStub(lookupValueHex) {
  return stubFetch({
    eth_chainId: () => "0x1e0", // 480, World Chain
    eth_call: (params) => {
      assert.equal(params[0].to, AGENTBOOK_CONTRACT);
      assert.equal(params[0].data.length, 2 + 8 + 64);
      return lookupValueHex;
    },
  });
}

test("lookupHuman: zero from the registry means not registered", async () => {
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(64)),
    rpcUrls: ["http://stub.invalid"],
  });
  assert.equal(await book.lookupHuman(signer.address), null);
});

test("lookupHuman: the raw value comes back in the W0 string form", async () => {
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(63) + "1"),
    rpcUrls: ["http://stub.invalid"],
  });
  assert.equal(await book.lookupHuman(signer.address), "0x01");
});

test("verifySeal on the browser provider: verified, with the pinned human hash", async () => {
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(63) + "1"),
    rpcUrls: ["http://stub.invalid"],
  });
  const result = await verifySeal(seal, { content: CONTENT, agentBook: book });
  assert.equal(result.state, "verified");
  assert.equal(result.checks.agentbook.status, "pass");
  assert.equal(result.human_id_hash, EXPECTED_HASH_FOR_UINT256_1);
});

test("verifySeal on the browser provider: tampered content is content-mismatch", async () => {
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(63) + "1"),
    rpcUrls: ["http://stub.invalid"],
  });
  const result = await verifySeal(seal, { content: CONTENT + "edited\n", agentBook: book });
  assert.equal(result.state, "failed");
  assert.ok(result.failures.includes("content-mismatch"));
});

test("RPC failure is check-incomplete, never wallet-not-registered", async () => {
  const down = async () => {
    throw new Error("network down");
  };
  const book = createBrowserAgentBook({ fetchImpl: down, rpcUrls: ["http://stub.invalid"] });
  const result = await verifySeal(seal, { content: CONTENT, agentBook: book });
  assert.equal(result.state, "check-incomplete");
  assert.equal(result.checks.agentbook.status, "incomplete");
  assert.ok(!result.failures.includes("wallet-not-registered"));
});

test("a non-World-Chain RPC answer is refused before any lookup is trusted", async () => {
  const wrongChain = stubFetch({
    eth_chainId: () => "0x1",
    eth_call: () => {
      throw new Error("must not be called");
    },
  });
  const book = createBrowserAgentBook({ fetchImpl: wrongChain, rpcUrls: ["http://stub.invalid"] });
  const result = await verifySeal(seal, { content: CONTENT, agentBook: book });
  assert.equal(result.checks.agentbook.status, "incomplete");
  assert.ok(!result.failures.includes("wallet-not-registered"));
});

const ANCHOR_TX = "0x" + "ab".repeat(32);

function anchorStub(calldataHex) {
  return stubFetch({
    eth_getTransactionReceipt: () => ({ blockNumber: "0x64", transactionHash: ANCHOR_TX }),
    eth_getTransactionByHash: () => ({ input: calldataHex }),
    eth_getBlockByNumber: () => ({ timestamp: "0x67200000" }),
    eth_blockNumber: () => "0x6e",
  });
}

test("getAnchor reads the hash from calldata and counts confirmations", async () => {
  const chain = createBrowserAnchorChain({
    fetchImpl: anchorStub(seal.content_hash.replace("sha256:", "0x")),
    rpcUrls: ["http://stub.invalid"],
  });
  const seen = await chain.getAnchor(ANCHOR_TX);
  assert.equal(seen.anchoredHash, seal.content_hash);
  assert.equal(seen.blockNumber, 100);
  assert.equal(seen.confirmations, 11);
});

test("verifySeal with a matching anchor: timing basis is the anchor", async () => {
  const chain = createBrowserAnchorChain({
    fetchImpl: anchorStub(seal.content_hash.replace("sha256:", "0x")),
    rpcUrls: ["http://stub.invalid"],
  });
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(63) + "1"),
    rpcUrls: ["http://stub.invalid"],
  });
  const anchored = withAnchor(seal, { tx_hash: ANCHOR_TX, chain: "eip155:480" });
  const result = await verifySeal(anchored, {
    content: CONTENT,
    agentBook: book,
    anchorChain: chain,
  });
  assert.equal(result.checks.anchor.status, "pass");
  assert.equal(result.timing.basis, "world-chain-anchor");
  assert.equal(result.state, "verified");
});

test("verifySeal with wrong calldata under the anchor tx: anchor-invalid", async () => {
  const chain = createBrowserAnchorChain({
    fetchImpl: anchorStub("0x" + "ff".repeat(32)),
    rpcUrls: ["http://stub.invalid"],
  });
  const book = createBrowserAgentBook({
    fetchImpl: agentBookStub("0x" + "0".repeat(63) + "1"),
    rpcUrls: ["http://stub.invalid"],
  });
  const anchored = withAnchor(seal, { tx_hash: ANCHOR_TX, chain: "eip155:480" });
  const result = await verifySeal(anchored, {
    content: CONTENT,
    agentBook: book,
    anchorChain: chain,
  });
  assert.equal(result.checks.anchor.status, "fail");
  assert.ok(result.failures.includes("anchor-invalid"));
});
