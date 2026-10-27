// Shared primitives: hashing, hex, deterministic JSON.
// SHA-256 comes from @noble/hashes (pure JavaScript, audited), so
// the identical code runs in Node and in the browser; the verify
// page loads these modules directly. Output is plain SHA-256 and
// stays cross-checkable with any system tool (sha256sum, Python
// hashlib) byte for byte; the canonicalisation vectors prove it.

import { sha256 } from "@noble/hashes/sha2.js";

export function sha256Bytes(bytes) {
  return sha256(bytes);
}

export function sha256Hex(bytes) {
  return bytesToHex(sha256Bytes(bytes));
}

/** Hash in the seal format's display form: "sha256:<64 hex>". */
export function sha256Prefixed(bytes) {
  return "sha256:" + sha256Hex(bytes);
}

export function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(text);
}

/**
 * Deterministic JSON serialisation for the signed payload:
 * object keys sorted at every depth, no insignificant whitespace,
 * UTF-8 output. Arrays keep their order. Only JSON values are
 * supported; undefined object values are rejected rather than
 * silently dropped, because a dropped field inside a signed payload
 * is a correctness bug.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const v = value[key];
      if (v === undefined) {
        throw new Error(`canonicalJson: undefined value at key "${key}"`);
      }
      parts.push(JSON.stringify(key) + ":" + canonicalJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}
