// Live providers for the verify page: AgentBook registration and
// World Chain anchor reads over plain JSON-RPC, small enough to
// audit in one sitting. No chain library: the page issues eth_call
// and receipt reads directly, so what it trusts is visible here.
//
// These providers run identically in the browser and in Node (the
// test suite drives them with a stubbed fetch), which is what makes
// the page's check logic provable offline.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8 } from "../src/util.js";

export const WORLD_CHAIN_ID = 480;
export const AGENTBOOK_CONTRACT = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";

// The public World Chain RPC endpoint published in World's docs.
// Callers may pass their own endpoints; a read that fails on every
// endpoint throws, and verifySeal reports that check as
// check-incomplete, never as a verdict.
export const DEFAULT_RPC_URLS = ["https://worldchain-mainnet.g.alchemy.com/public"];

function functionSelector(signature) {
  return bytesToHex(keccak_256(utf8(signature)).slice(0, 4));
}

async function rpc(fetchImpl, url, method, params) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? "error"}`);
  return body.result;
}

async function rpcAny(fetchImpl, urls, method, params) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await rpc(fetchImpl, url, method, params);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`RPC ${method}: no endpoints configured`);
}

// The endpoint itself can answer for any chain, so pin its live
// identity before trusting either a positive or a zero AgentBook
// response (the same guard the W0 core's reader applies).
async function assertWorldChain(fetchImpl, urls) {
  const chainIdHex = await rpcAny(fetchImpl, urls, "eth_chainId", []);
  if (parseInt(chainIdHex, 16) !== WORLD_CHAIN_ID) {
    throw new Error("AgentBook RPC is not World Chain.");
  }
}

function isoFromUnixSeconds(seconds) {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * AgentBook provider in the shape verifySeal consumes.
 * lookupHuman(address) -> raw humanId string | null, throws on any
 * transport or chain failure. The raw value is returned only so
 * verifySeal can hash it in-process (the program-canonical
 * construction, W0 SPEC 3.5); it must never be displayed, logged,
 * or stored by the caller. The string form matches the W0 core's
 * reader exactly: viem toHex(uint256), a 0x-prefixed minimal-length
 * hex string with an even number of digits.
 */
export function createBrowserAgentBook({ rpcUrls = DEFAULT_RPC_URLS, fetchImpl = fetch } = {}) {
  return {
    source: "agentbook-live-rpc",
    async lookupHuman(address) {
      await assertWorldChain(fetchImpl, rpcUrls);
      const data =
        "0x" +
        functionSelector("lookupHuman(address)") +
        String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const result = await rpcAny(fetchImpl, rpcUrls, "eth_call", [
        { to: AGENTBOOK_CONTRACT, data },
        "latest",
      ]);
      const value = BigInt(result);
      if (value === 0n) return null;
      let hex = value.toString(16);
      if (hex.length % 2 !== 0) hex = "0" + hex;
      return "0x" + hex;
    },
  };
}

/**
 * Anchor provider in the shape verifySeal consumes.
 * getAnchor(txHash) -> { anchoredHash, blockNumber, blockTimestamp,
 * confirmations } | null (transaction not found). The anchor method
 * is hash-in-calldata: the transaction's input must be exactly the
 * 32 content-hash bytes; anything else is returned as-is and fails
 * the comparison in verifySeal as anchor-invalid, by design.
 */
export function createBrowserAnchorChain({ rpcUrls = DEFAULT_RPC_URLS, fetchImpl = fetch } = {}) {
  return {
    source: "worldchain-live-rpc",
    async getAnchor(txHash) {
      const receipt = await rpcAny(fetchImpl, rpcUrls, "eth_getTransactionReceipt", [txHash]);
      if (!receipt) return null;
      const tx = await rpcAny(fetchImpl, rpcUrls, "eth_getTransactionByHash", [txHash]);
      const block = await rpcAny(fetchImpl, rpcUrls, "eth_getBlockByNumber", [
        receipt.blockNumber,
        false,
      ]);
      const latest = await rpcAny(fetchImpl, rpcUrls, "eth_blockNumber", []);
      const blockNumber = parseInt(receipt.blockNumber, 16);
      const confirmations = Math.max(0, parseInt(latest, 16) - blockNumber + 1);
      return {
        anchoredHash: "sha256:" + String(tx?.input ?? "").replace(/^0x/, "").toLowerCase(),
        blockNumber,
        blockTimestamp: isoFromUnixSeconds(parseInt(block.timestamp, 16)),
        confirmations,
      };
    },
  };
}
