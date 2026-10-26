// Shared fixtures for the W3 library tests.
//
// The private keys below are the two most widely published test
// keys in the ecosystem (Hardhat/Anvil default accounts #0 and #1).
// They are public knowledge, hold no funds in these tests, and are
// used ONLY as deterministic fixtures. The production sealing
// wallet's key lives in the secrets vault and appears nowhere in
// this repository (SPEC.md 9.2 / 9.3).

import { PrivateKeySigner } from "../src/wallet.js";

export const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const TEST_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TEST_ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// A clearly synthetic stand-in for an AgentBook humanId. The real
// value is never used in tests, fixtures, or this repository
// (THE HUMANID RULE); this string exists so tests can assert that
// whatever a provider returns is hashed before it is displayed.
export const SYNTHETIC_HUMAN_ID = "synthetic-human-id-for-tests-0001";

export function testSigner() {
  return new PrivateKeySigner(TEST_KEY_0);
}

export function otherSigner() {
  return new PrivateKeySigner(TEST_KEY_1);
}

/** AgentBook provider backed by a plain { address: humanId } map. */
export function mockAgentBook(map) {
  return {
    async lookupHuman(address) {
      const key = Object.keys(map).find(
        (k) => k.toLowerCase() === String(address).toLowerCase(),
      );
      return key ? map[key] : null;
    },
  };
}

export function registeredAgentBook() {
  return mockAgentBook({ [TEST_ADDRESS_0]: SYNTHETIC_HUMAN_ID });
}

export function throwingAgentBook() {
  return {
    async lookupHuman() {
      throw new Error("simulated RPC failure");
    },
  };
}

export const FIXTURE_CONTENT = [
  "# Fixture post",
  "",
  "This is a synthetic fixture post for the provenance seal tests.",
  "It was written by nobody, about nothing, for byte-checking.",
  "",
].join("\n");

export function fixtureSealOptions(overrides = {}) {
  return {
    content: FIXTURE_CONTENT,
    surface: "personal-website",
    contentId: "posts/fixture-post",
    canonicalUrl: "https://example.invalid/posts/fixture-post",
    title: "Fixture post",
    persona: "Fixture Agent",
    signer: testSigner(),
    sealedAt: "2026-10-26T04:00:00Z",
    ...overrides,
  };
}
