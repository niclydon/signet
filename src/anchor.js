// Anchoring, per SPEC.md section 6. A hash anchored on World Chain
// proves the hash existed no later than the anchor block's time, and
// nothing more.
//
// This module defines the provider interface and two
// implementations:
//   - MockLocalChain: an in-memory chain for offline tests. Blocks
//     are mined explicitly or on each anchor write; timestamps come
//     from an injected clock so vectors are deterministic.
//   - WorldChainAnchorProvider: the real chain shape, deliberately
//     STACKED for the overnight build. It performs its reads and
//     writes only through functions injected by the caller, and
//     with none injected it refuses with AnchorNotConfigured. The
//     sealing wallet is unfunded by design tonight; the exact
//     funding and write steps are documented in
//     the operator runbook and are a morning, operator-gated
//     step, not something this library attempts on its own.

import { sha256Hex, utf8 } from "./util.js";

export const WORLD_CHAIN_ID = "eip155:480";

/** Calldata form for a hash-only anchor write: the 32 hash bytes, nothing else. */
export function anchorCalldata(contentHash) {
  const hex = contentHash.replace(/^sha256:/, "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("anchorCalldata: expected a 32-byte hash");
  return "0x" + hex.toLowerCase();
}

export class AnchorNotConfigured extends Error {
  constructor(message = "World Chain anchor provider is not configured (no writer/reader injected); the funding and write steps are documented in the operator runbook") {
    super(message);
    this.name = "AnchorNotConfigured";
    this.code = "anchor-not-configured";
  }
}

/**
 * In-memory mock chain implementing the anchor provider interface:
 *   anchorHash(contentHash) -> anchor object as in SPEC 4.3
 *   getAnchor(txHash) -> { anchoredHash, blockNumber, blockTimestamp, confirmations } | null
 *   mineBlock() -> advances the chain head (for confirmation tests)
 */
export class MockLocalChain {
  constructor({ startBlock = 1000, startTimeIso = "2026-10-26T04:00:00Z", blockSeconds = 12 } = {}) {
    this.head = startBlock;
    this.blockSeconds = blockSeconds;
    this.startMs = Date.parse(startTimeIso);
    this.txs = new Map();
  }

  blockTimestamp(blockNumber) {
    const ms = this.startMs + (blockNumber - 1000) * this.blockSeconds * 1000;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  mineBlock() {
    this.head += 1;
    return this.head;
  }

  async anchorHash(contentHash) {
    const blockNumber = this.mineBlock();
    const seed = `mock-anchor:${contentHash}:${blockNumber}`;
    const txHash = "0x" + sha256Hex(utf8(seed));
    const record = {
      anchoredHash: contentHash,
      blockNumber,
      blockTimestamp: this.blockTimestamp(blockNumber),
    };
    this.txs.set(txHash, record);
    return {
      chain: WORLD_CHAIN_ID,
      tx_hash: txHash,
      block_number: blockNumber,
      block_timestamp: record.blockTimestamp,
      anchored_hash: contentHash,
    };
  }

  async getAnchor(txHash) {
    const record = this.txs.get(txHash);
    if (!record) return null;
    return {
      ...record,
      confirmations: this.head - record.blockNumber + 1,
    };
  }
}

/**
 * Real-chain provider shape. The caller injects:
 *   writer: async ({ to, data, from }) -> txHash
 *   reader: async (txHash) -> { anchoredHash, blockNumber, blockTimestamp, confirmations } | null
 * With no writer, anchorHash throws AnchorNotConfigured; with no
 * reader, getAnchor throws AnchorNotConfigured (which verification
 * surfaces as check-incomplete, never as a pass or a not-registered
 * style failure).
 */
export class WorldChainAnchorProvider {
  constructor({ writer = null, reader = null, anchorAddress = null } = {}) {
    this.writer = writer;
    this.reader = reader;
    this.anchorAddress = anchorAddress;
  }

  async anchorHash(contentHash, { from } = {}) {
    if (!this.writer) throw new AnchorNotConfigured();
    const data = anchorCalldata(contentHash);
    const txHash = await this.writer({ to: this.anchorAddress ?? from, data, from });
    const seen = this.reader ? await this.reader(txHash) : null;
    return {
      chain: WORLD_CHAIN_ID,
      tx_hash: txHash,
      block_number: seen ? seen.blockNumber : null,
      block_timestamp: seen ? seen.blockTimestamp : null,
      anchored_hash: contentHash,
    };
  }

  async getAnchor(txHash) {
    if (!this.reader) throw new AnchorNotConfigured();
    return this.reader(txHash);
  }
}
