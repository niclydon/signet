#!/usr/bin/env node
// Offline CLI for the W3 seal library. This is a test harness, not
// the production sealing workflow (that is the GitHub Action in
// the design spec, with the key materialised from the vault).
//
//   w3-seal hash <file>
//   w3-seal seal <file> --surface S --id ID --url URL --persona P [--title T] [--out seal.json]
//       (signing key from env W3_SEALING_PRIVATE_KEY; never printed)
//   w3-seal verify <seal.json> [--content <file>] [--agentbook registered|unregistered|down]
//   w3-seal anchor-demo
//       (seal + anchor + verify, end to end against the mock chain)

import { readFileSync, writeFileSync } from "node:fs";
import {
  contentHash,
  canonicalBytes,
  createSeal,
  verifySeal,
  MockLocalChain,
  withAnchor,
  PrivateKeySigner,
} from "../src/index.js";

const SYNTHETIC_HUMAN_ID = "synthetic-human-id-for-tests-0001";

function argValue(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "hash") {
    const text = readFileSync(args[0], "utf8");
    console.log(JSON.stringify({ content_hash: contentHash(text), canonical_bytes: canonicalBytes(text).length }, null, 2));
    return;
  }

  if (command === "seal") {
    const key = process.env.W3_SEALING_PRIVATE_KEY;
    if (!key) {
      console.error("W3_SEALING_PRIVATE_KEY is not set; the CLI never generates or stores keys.");
      process.exit(2);
    }
    const signer = new PrivateKeySigner(key);
    const text = readFileSync(args[0], "utf8");
    const seal = createSeal({
      content: text,
      surface: argValue(args, "--surface", "personal-website"),
      contentId: argValue(args, "--id", args[0]),
      canonicalUrl: argValue(args, "--url", "https://example.invalid/"),
      persona: argValue(args, "--persona", "Fixture Agent"),
      title: argValue(args, "--title"),
      signer,
    });
    const out = argValue(args, "--out");
    const json = JSON.stringify(seal, null, 2) + "\n";
    if (out) writeFileSync(out, json);
    else process.stdout.write(json);
    return;
  }

  if (command === "verify") {
    const seal = JSON.parse(readFileSync(args[0], "utf8"));
    const contentPath = argValue(args, "--content");
    const mode = argValue(args, "--agentbook", "registered");
    const agentBook = {
      async lookupHuman(address) {
        if (mode === "down") throw new Error("simulated RPC failure");
        if (mode === "unregistered") return null;
        return String(address).toLowerCase() === seal.agent.wallet_address.toLowerCase()
          ? SYNTHETIC_HUMAN_ID
          : null;
      },
    };
    const result = await verifySeal(seal, {
      content: contentPath ? readFileSync(contentPath, "utf8") : null,
      agentBook,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "anchor-demo") {
    const key = process.env.W3_SEALING_PRIVATE_KEY;
    if (!key) {
      console.error("W3_SEALING_PRIVATE_KEY is not set; use the published Hardhat test key for the demo.");
      process.exit(2);
    }
    const signer = new PrivateKeySigner(key);
    const chain = new MockLocalChain();
    const content = "Anchor demo content, sealed offline.\n";
    const seal = createSeal({
      content,
      surface: "personal-website",
      contentId: "demo/anchor",
      canonicalUrl: "https://example.invalid/demo/anchor",
      persona: "Fixture Agent",
      signer,
    });
    const anchor = await chain.anchorHash(seal.content_hash);
    const anchored = withAnchor(seal, anchor);
    const result = await verifySeal(anchored, {
      content,
      anchorChain: chain,
      agentBook: {
        async lookupHuman() {
          return SYNTHETIC_HUMAN_ID;
        },
      },
    });
    console.log(JSON.stringify({ seal: anchored, verify_result: result }, null, 2));
    return;
  }

  console.error("usage: w3-seal hash|seal|verify|anchor-demo ...");
  process.exit(2);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
