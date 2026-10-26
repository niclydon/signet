// EVM wallet primitives for the sealing wallet: EIP-55 checksummed
// addresses and EIP-191 personal_sign with public-key recovery.
// Built on @noble/curves (secp256k1) and @noble/hashes (keccak-256),
// the audited minimal libraries; no framework dependency.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8 } from "./util.js";

/** Derive the EIP-55 checksummed address for a public key point. */
export function publicKeyToAddress(point) {
  const uncompressed = point.toBytes(false); // 0x04 || X || Y
  const hash = keccak_256(uncompressed.slice(1));
  const raw = bytesToHex(hash.slice(12));
  return toChecksumAddress("0x" + raw);
}

/** EIP-55 checksum encoding of a 20-byte address. */
export function toChecksumAddress(address) {
  const lower = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("invalid address");
  const hash = bytesToHex(keccak_256(utf8(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

function pointFromPrivateKey(privateKeyHex) {
  const priv = hexToBytes(privateKeyHex);
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  return secp256k1.Point.fromHex(secp256k1.getPublicKey(priv, false));
}

export function privateKeyToAddress(privateKeyHex) {
  return publicKeyToAddress(pointFromPrivateKey(privateKeyHex));
}

/** EIP-191 message hash: keccak256(prefix || message). */
export function eip191Hash(message) {
  const body = typeof message === "string" ? utf8(message) : message;
  const prefix = utf8(`\x19Ethereum Signed Message:\n${body.length}`);
  const data = new Uint8Array(prefix.length + body.length);
  data.set(prefix, 0);
  data.set(body, prefix.length);
  return keccak_256(data);
}

/**
 * A signer for the sealing wallet. The library never stores keys:
 * in production the key is materialised from the secrets vault into
 * the sealing process only (SPEC.md 9.2), and in tests a published
 * test key is used.
 */
export class PrivateKeySigner {
  constructor(privateKeyHex) {
    this._priv = hexToBytes(privateKeyHex);
    if (this._priv.length !== 32) throw new Error("private key must be 32 bytes");
    this.address = privateKeyToAddress(privateKeyHex);
  }

  /** Sign a text message with EIP-191. Returns 0x-prefixed 65-byte hex (r||s||v, v = 27 or 28). */
  signMessage(message) {
    const hash = eip191Hash(message);
    const sig = secp256k1.sign(hash, this._priv, { lowS: true });
    const r = sig.r.toString(16).padStart(64, "0");
    const s = sig.s.toString(16).padStart(64, "0");
    const v = (27 + sig.recovery).toString(16).padStart(2, "0");
    return "0x" + r + s + v;
  }
}

/** Recover the signer's checksummed address from an EIP-191 signature over a text message. */
export function recoverMessageAddress(message, signatureHex) {
  const sigBytes = hexToBytes(signatureHex);
  if (sigBytes.length !== 65) throw new Error("signature must be 65 bytes");
  const r = BigInt("0x" + bytesToHex(sigBytes.slice(0, 32)));
  const s = BigInt("0x" + bytesToHex(sigBytes.slice(32, 64)));
  const v = sigBytes[64];
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error("invalid signature v");
  const sig = new secp256k1.Signature(r, s, recovery);
  const point = sig.recoverPublicKey(eip191Hash(message));
  if (!point) throw new Error("signature recovery failed");
  return publicKeyToAddress(point);
}
