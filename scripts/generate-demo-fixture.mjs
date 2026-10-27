// Regenerate verify/demo-fixture.json: the verify page's sample.
// The sample seal is made with the published Hardhat test key 0 and
// is labelled as a test fixture everywhere it appears; the sample
// registration is a recorded fixture (a precomputed human hash for
// the synthetic human id 0x01), never a live lookup and never a real
// person's data. Run: node scripts/generate-demo-fixture.mjs

import { writeFile } from "node:fs/promises";
import { createSeal } from "../src/seal.js";
import { PrivateKeySigner } from "../src/wallet.js";
import { humanIdHash } from "../src/verify.js";

const HARDHAT_TEST_KEY_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const content = [
  "# Why this post carries a seal",
  "",
  "This is a sample post for the Signet verify page, sealed with a",
  "published test key so anyone can reproduce it. A real seal is",
  "made the same way: the text is hashed, the sealing wallet signs",
  "the hash, and anyone can check that the wallet is registered",
  "to a verified unique human.",
  "",
].join("\n");

const signer = new PrivateKeySigner(HARDHAT_TEST_KEY_0);
const seal = createSeal({
  content,
  surface: "web",
  contentId: "signet-demo-post",
  canonicalUrl: "https://example.invalid/signet-demo-post",
  persona: "signet-demo",
  signer,
  sealedAt: "2026-10-26T00:00:00Z",
});

const fixture = {
  label:
    "Sample seal made with the published Hardhat test key 0. The registration below is a recorded fixture for a synthetic test human, not a live lookup.",
  seal,
  content,
  fixture_registration: {
    wallet_address: signer.address,
    humanHash: humanIdHash("0x01").replace(/^sha256:/, ""),
  },
};

await writeFile(
  new URL("../verify/demo-fixture.json", import.meta.url),
  JSON.stringify(fixture, null, 2) + "\n",
);
console.log("wrote verify/demo-fixture.json for wallet", signer.address);
