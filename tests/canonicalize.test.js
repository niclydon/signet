// Canonicalization vectors are byte-checked against an independent
// Python implementation (vectors/generate_vectors.py), not against
// the JS implementation's own output.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalBytes, canonicalizeText, contentHash } from "../src/canonicalize.js";
import { sha256Hex } from "../src/util.js";

const doc = JSON.parse(
  readFileSync(new URL("../vectors/canonicalization.json", import.meta.url), "utf8"),
);

test("vector file declares w3-text-v1", () => {
  assert.equal(doc.c14n, "w3-text-v1");
  assert.ok(doc.vectors.length >= 12);
});

for (const vector of doc.vectors) {
  test(`canonicalize: ${vector.name}`, () => {
    const input = Buffer.from(vector.input_b64, "base64").toString("utf8");
    const expected = Buffer.from(vector.canonical_b64, "base64");
    const actual = Buffer.from(canonicalBytes(input));
    assert.deepEqual(actual, expected, "canonical bytes differ from the independent vector");
    assert.equal(sha256Hex(actual), vector.canonical_sha256);
    assert.equal(contentHash(input), "sha256:" + vector.canonical_sha256);
  });
}

test("canonicalize is idempotent on every vector", () => {
  for (const vector of doc.vectors) {
    const canonical = Buffer.from(vector.canonical_b64, "base64").toString("utf8");
    assert.equal(canonicalizeText(canonical), canonical, vector.name);
  }
});

test("one changed character changes the hash", () => {
  const a = contentHash("Fixture body, line one.\n");
  const b = contentHash("Fixture body, line one!\n");
  assert.notEqual(a, b);
});
