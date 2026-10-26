// Live evidence run for the W0 adapter. NOT part of the test
// suite: it talks to the real AgentBook contract on World Chain
// through the real @fiador/verify package, so it runs where that
// package is checked out (Furnace), on demand:
//
//   FIADOR_VERIFY_DIST=/path/to/packages/verify-ts/dist/index.js \
//     node scripts/live-w0-check.mjs
//
// It checks four things and prints one JSON object:
//   1. a known-registered wallet resolves through the adapter to a
//      humanHash (the raw humanId never reaches this script: W0's
//      public result shape does not carry it);
//   2. a known-unregistered wallet resolves to null;
//   3. a dead RPC makes the adapter throw (W3: check-incomplete,
//      never a fabricated unregistered);
//   4. verifySeal end to end with the live adapter: the fixture
//      seal (test key, unregistered wallet) reports
//      wallet-not-registered with a passing signature, and a seal
//      record naming the registered wallet passes the AgentBook
//      check with the same hash as step 1 (its signature check
//      fails, as it must: the fixture key does not hold that
//      wallet, and the checks are reported separately by design).

import { pathToFileURL } from "node:url";
import { createSeal, verifySeal, w0AgentBookProvider, PrivateKeySigner } from "../src/index.js";

const DIST =
  process.env.FIADOR_VERIFY_DIST ??
  "/home/niclydon/projects/human-backed/packages/verify-ts/dist/index.js";
const { createVerifier } = await import(pathToFileURL(DIST).href);

// Registered per the program record: the Furnace playground wallet,
// confirmed registered:true by a live AgentBook check on
// Oct 25, 2026. A wallet address is public data.
const REGISTERED = "0x7d7D277766073c3381c79F1aC9a38B385a26097f";
// Published Hardhat test account #0: holds no AgentBook entry.
const TEST_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTENT = "Live adapter check fixture.\n";

const out = {};

const live = createVerifier();
const provider = w0AgentBookProvider(live);

const registered = await provider.lookupHuman(REGISTERED);
out.registered_lookup = registered ? { human_id_hash: `sha256:${registered.humanHash}` } : null;

out.unregistered_lookup = await provider.lookupHuman(TEST_ADDRESS_0);

const dead = w0AgentBookProvider(
  createVerifier({ rpcUrl: "http://127.0.0.1:9/unreachable", timeoutMs: 4000 }),
);
try {
  await dead.lookupHuman(REGISTERED);
  out.dead_rpc = "did-not-throw (UNEXPECTED)";
} catch (err) {
  out.dead_rpc = `threw: ${err.message.slice(0, 80)}`;
}

const signer = new PrivateKeySigner(TEST_KEY_0);
const seal = createSeal({
  content: CONTENT,
  surface: "personal-website",
  contentId: "live-check/fixture",
  canonicalUrl: "https://example.invalid/live-check/fixture",
  persona: "Fixture Agent",
  signer,
});
const endToEnd = await verifySeal(seal, { content: CONTENT, agentBook: provider });
out.verify_fixture_seal = {
  state: endToEnd.state,
  signature: endToEnd.checks.signature.status,
  agentbook: endToEnd.checks.agentbook.status,
  failures: endToEnd.failures,
};

const claiming = JSON.parse(JSON.stringify(seal));
claiming.agent.wallet_address = REGISTERED;
const claimed = await verifySeal(claiming, { agentBook: provider });
out.verify_claiming_registered_wallet = {
  agentbook: claimed.checks.agentbook.status,
  human_id_hash: claimed.human_id_hash,
  signature: claimed.checks.signature.status,
  hash_matches_step_1: claimed.human_id_hash === out.registered_lookup?.human_id_hash,
};

console.log(JSON.stringify(out, null, 2));
