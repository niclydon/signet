// Tests for the ProvenanceSeal component's pure line model and
// renderer (components/ProvenanceSeal/provenance-seal.js), covering
// the SPEC 8 rules: the pill always carries the tier word, the
// tier is structural (filled versus outline mark), a static render
// defaults to sealed-unchecked with the spec's exact wording,
// superseded content links forward, and no human identifier in
// any form appears anywhere in the output.

import test from "node:test";
import assert from "node:assert/strict";
import { sealLines, renderSealHtml, shortHash } from "../components/ProvenanceSeal/provenance-seal.js";

const BASE = {
  contentHash: "sha256:" + "ab".repeat(32),
  verifyUrl: "https://example.com/verify/" + "ab".repeat(32),
  persona: "Nova",
  tier: "not-approved",
  timingBasis: "signer-claimed",
  sealedAt: "2026-10-26T12:00:00Z",
  surface: "personal-website",
};

test("full density carries the whole anatomy in order", () => {
  const model = sealLines({ ...BASE, density: "full" });
  assert.equal(model.markWord, "Provenance seal");
  assert.match(model.lines[0], /^Written by agent Nova\. Backed by a unique verified human\.$/);
  assert.equal(model.lines[1], "Human approved: no");
  assert.match(model.lines[2], /Sealed claimed 2026-10-26/);
  assert.match(model.lines[2], /personal-website/);
});

test("approved tier is structural: filled mark and the word approved", () => {
  const approved = sealLines({ ...BASE, tier: "approved", density: "full" });
  assert.equal(approved.markVariant, "filled");
  assert.equal(approved.lines[1], "Human approved: yes");
  const notApproved = sealLines({ ...BASE, tier: "not-approved", density: "full" });
  assert.equal(notApproved.markVariant, "outline");
});

test("the pill always carries the tier word, in both tiers", () => {
  for (const tier of ["approved", "not-approved"]) {
    const model = sealLines({ ...BASE, tier, density: "pill" });
    assert.match(model.lines[0], tier === "approved" ? /· approved ·/ : /· not approved ·/);
    assert.match(model.lines[0], new RegExp(shortHash(BASE.contentHash).replace("…", "…")));
  }
});

test("compact uses the short tier form and the short hash", () => {
  const model = sealLines({ ...BASE, density: "compact" });
  assert.equal(model.lines[1], "Approved: no");
  assert.equal(model.lines[2], shortHash(BASE.contentHash));
});

test("default state is sealed-unchecked with the spec's exact wording", () => {
  const model = sealLines({ ...BASE, density: "full" });
  assert.equal(model.state, "sealed-unchecked");
  assert.equal(model.lines.at(-1), "Seal recorded. Live status on the verify page.");
});

test("superseded keeps the seal and links to the current version", () => {
  const model = sealLines({
    ...BASE,
    density: "full",
    state: "superseded",
    currentVerifyUrl: "https://example.com/verify/current",
  });
  assert.equal(model.currentVerifyUrl, "https://example.com/verify/current");
  const html = renderSealHtml({
    ...BASE,
    density: "full",
    state: "superseded",
    currentVerifyUrl: "https://example.com/verify/current",
  });
  assert.match(html, /Current version's seal/);
  assert.match(html, /Verify this seal/);
});

test("anchor timing is labelled anchored, with the anchor date", () => {
  const model = sealLines({
    ...BASE,
    density: "full",
    timingBasis: "world-chain-anchor",
    anchorTime: "2026-10-27T00:00:00Z",
  });
  assert.match(model.lines[2], /Sealed anchored 2026-10-27/);
});

test("rendered output contains no human identifier and no World marks", () => {
  for (const density of ["full", "compact", "pill"]) {
    const html = renderSealHtml({ ...BASE, density });
    assert.doesNotMatch(html, /human_?id/i);
    assert.doesNotMatch(html, /world/i);
    assert.match(html, /Verify this seal/);
  }
});

test("invalid tier, state, and density fall back to the safe defaults", () => {
  const model = sealLines({ ...BASE, tier: "gold", state: "verified", density: "huge" });
  assert.equal(model.tier, "not-approved");
  assert.equal(model.state, "sealed-unchecked");
  assert.equal(model.density, "full");
});
