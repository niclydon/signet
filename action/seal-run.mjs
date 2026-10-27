// The sealing run behind the GitHub Action (design SPEC section 9).
// One function, runSealing, with every side effect injected, so the
// Action's behaviour is testable offline: publish-time sealing, PR
// dry runs on an ephemeral key, idempotent re-runs, supersession,
// the approval gate, anchor fail-open with disclosure, and the
// fail-closed paths that publish nothing.
//
// Custody rules enforced here and in the workflow:
// - The sealing key arrives only as a file path or env value on
//   publish runs; it is never logged and never cached.
// - Dry runs use an ephemeral key generated in memory and never
//   touch the seals directory.
// - The run never resolves, reads, or prints any human identifier;
//   registration is a verify-time check, so the raw value never
//   enters CI at all.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { canonicalBytes, contentHash, splitFrontMatter } from "../src/canonicalize.js";
import { createSeal, withAnchor } from "../src/seal.js";
import { PrivateKeySigner } from "../src/wallet.js";
import { utf8 } from "../src/util.js";

const execFileAsync = promisify(execFile);

/** Commit-message guard for the commit-back loop (SPEC 9.2 step 7). */
export function isSealCommit(message) {
  return typeof message === "string" && message.startsWith("seal:");
}

/** Minimal glob: supports ** (any depth), * (one segment), ? (one char). */
export function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

export function matchesAny(path, globs) {
  return (globs ?? []).some((g) => globToRegExp(g).test(path));
}

async function walkFiles(root, dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walkFiles(root, full, acc);
    } else if (entry.isFile()) {
      acc.push(full.slice(root.length + 1));
    }
  }
  return acc;
}

async function loadSeals(root, sealsDir) {
  const dir = join(root, sealsDir);
  const seals = [];
  if (!existsSync(dir)) return seals;
  const files = (await walkFiles(root, dir)).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (file === join(sealsDir, "index.json")) continue;
    try {
      seals.push({ file, seal: JSON.parse(await readFile(join(root, file), "utf8")) });
    } catch {
      // A malformed seal file is an existing-seal inconsistency:
      // surfaced by the caller through the parse failure list.
      seals.push({ file, seal: null });
    }
  }
  return seals;
}

async function loadIndex(root, sealsDir) {
  const path = join(root, sealsDir, "index.json");
  if (!existsSync(path)) return { version: 1, seals: {} };
  return JSON.parse(await readFile(path, "utf8"));
}

function shortHash(hash) {
  const hex = String(hash).replace(/^sha256:/, "");
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export function ephemeralSigner() {
  return new PrivateKeySigner("0x" + randomBytes(32).toString("hex"));
}

/** Anchor function from a configured shell command: hash as argv[1], anchor JSON on stdout. */
export function commandAnchorFn(command) {
  return async (hash) => {
    const { stdout } = await execFileAsync(command, [hash], { timeout: 120_000 });
    return JSON.parse(stdout);
  };
}

/**
 * Run one sealing pass.
 *
 * options:
 *   root       consumer repo root (absolute)
 *   config     the surface config object (see action/README.md)
 *   mode       "publish" | "dry-run"
 *   files      explicit relative file list, or null to scan config.content globs
 *   signer     PrivateKeySigner for publish; ignored in dry-run (ephemeral is used)
 *   anchorFn   async (contentHash) -> anchor object, or null when anchoring is not configured
 *   writeFiles set false to compute everything without touching disk (tests, dry runs)
 *
 * Returns { ok, results, summaryMarkdown, anchorPending }.
 * Fail-closed rule: if any item errors in a fail-closed class, ok is
 * false and NOTHING is written, even for items that sealed cleanly.
 */
export async function runSealing(options) {
  const {
    root,
    config,
    mode = "publish",
    files = null,
    signer = null,
    anchorFn = null,
    writeFiles = true,
  } = options;
  const dryRun = mode === "dry-run";
  const sealsDir = config.sealsDir ?? "_seals";
  const results = [];
  const anchorPending = [];
  let failed = false;

  const activeSigner = dryRun ? ephemeralSigner() : signer;
  if (!activeSigner) throw new TypeError("runSealing: publish mode needs a signer");

  // Step 1: resolve the content set.
  let candidates = files;
  if (candidates == null) {
    const all = await walkFiles(root, root);
    candidates = all.filter(
      (f) => matchesAny(f, config.content) && !matchesAny(f, config.exclude ?? []),
    );
  } else {
    candidates = candidates.filter(
      (f) => matchesAny(f, config.content) && !matchesAny(f, config.exclude ?? []),
    );
  }
  candidates.sort();

  const existing = await loadSeals(root, sealsDir);
  const index = await loadIndex(root, sealsDir);
  if (existing.some((e) => e.seal === null)) {
    results.push({ status: "error", error: "a seal file in the seals directory is malformed" });
    return finish(false);
  }

  const plannedWrites = [];

  for (const relPath of candidates) {
    const contentId = relPath;
    const raw = await readFile(join(root, relPath), "utf8");
    const scoped = config.hashScope === "body" ? splitFrontMatter(raw).body : raw;

    // Step 2: the committed source must already be canonical.
    const canonical = canonicalBytes(scoped);
    const scopedBytes = utf8(scoped);
    if (Buffer.compare(Buffer.from(canonical), Buffer.from(scopedBytes)) !== 0) {
      results.push({
        file: relPath,
        status: "error",
        error: "content is not in canonical w3-text-v1 form; commit the canonicalised source first",
      });
      failed = true;
      continue;
    }
    const hash = contentHash(scoped);

    // Step 3: idempotency and supersession.
    const sameHash = existing.find((e) => e.seal.content_hash === hash);
    if (sameHash && sameHash.seal.content?.surface === config.surface && sameHash.seal.content?.content_id === contentId) {
      results.push({ file: relPath, status: "skipped", contentHash: hash, reason: "already sealed for this hash, surface, and content_id" });
      continue;
    }
    const prior = index.seals[contentId]?.content_hash ?? null;

    // Step 4: approval gate. The gate enforces the surface's
    // publication policy; it never writes an approval claim into a
    // seal (createSeal cannot), and it never manufactures a record.
    let approvalNote = "not required";
    if (config.approval?.required) {
      const recordsDir = config.approval.recordsDir ?? "_approvals";
      const recordPath = join(root, recordsDir, `${hash.replace(/^sha256:/, "")}.json`);
      let confirmed = false;
      if (existsSync(recordPath)) {
        try {
          const record = JSON.parse(await readFile(recordPath, "utf8"));
          confirmed = record?.content_hash === hash && record?.confirmed === true;
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        if ((config.approval.fallback ?? "fail") === "fail") {
          results.push({ file: relPath, status: "error", contentHash: hash, error: "approval required for this surface and no confirmed approval record exists for this hash" });
          failed = true;
          continue;
        }
        approvalNote = "required, none confirmed; published as not approved per surface fallback";
      } else {
        approvalNote = "confirmed approval record present for this hash";
      }
    }

    // Step 5: sign.
    let seal = createSeal({
      content: scoped,
      surface: config.surface,
      contentId,
      canonicalUrl: String(config.canonicalUrlBase ?? "").replace(/\/?$/, "/") + relPath,
      persona: config.persona,
      signer: activeSigner,
      supersedes: prior,
    });

    // Step 6: anchor, fail-open with disclosure unless required.
    let anchorStatus = "not configured";
    if (!dryRun && anchorFn) {
      const retries = config.anchor?.retries ?? 3;
      let anchor = null;
      let lastError = null;
      for (let attempt = 0; attempt < retries && !anchor; attempt++) {
        try {
          anchor = await anchorFn(hash);
        } catch (err) {
          lastError = err;
        }
      }
      if (anchor) {
        seal = withAnchor(seal, anchor);
        anchorStatus = `anchored (${anchor.tx_hash ?? "tx recorded"})`;
      } else if (config.anchor?.required) {
        results.push({ file: relPath, status: "error", contentHash: hash, error: `anchor required and failed after ${retries} attempts: ${lastError?.message ?? "unknown"}` });
        failed = true;
        continue;
      } else {
        anchorStatus = "failed; published unanchored, tracking entry recorded";
        anchorPending.push({ content_id: contentId, content_hash: hash, error: String(lastError?.message ?? "unknown") });
      }
    } else if (dryRun) {
      anchorStatus = "dry run, not attempted";
    }

    const sealRelPath = join(sealsDir, `${relPath}.json`);
    results.push({
      file: relPath,
      status: dryRun ? "dry-run" : "sealed",
      contentHash: hash,
      tier: "not-approved",
      approvalNote,
      anchorStatus,
      supersedes: prior,
      sealFile: sealRelPath,
      signerAddress: activeSigner.address,
    });
    plannedWrites.push({ sealRelPath, seal, contentId, hash, prior });
  }

  if (failed) return finish(false);

  // Step 7 (write phase): seals plus the regenerated index, only
  // when the whole run is clean.
  if (!dryRun && writeFiles) {
    for (const write of plannedWrites) {
      const full = join(root, write.sealRelPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, JSON.stringify(write.seal, null, 2) + "\n");
      index.seals[write.contentId] = {
        content_hash: write.hash,
        seal_file: write.sealRelPath,
        supersedes: write.prior,
      };
    }
    if (plannedWrites.length > 0) {
      await mkdir(join(root, sealsDir), { recursive: true });
      await writeFile(join(root, sealsDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
    }
    if (anchorPending.length > 0) {
      await writeFile(
        join(root, sealsDir, "anchor-pending.json"),
        JSON.stringify(anchorPending, null, 2) + "\n",
      );
    }
  }

  return finish(true);

  function finish(ok) {
    const lines = [
      `## Signet sealing run (${dryRun ? "dry run, unrecorded" : "publish"})`,
      "",
      "| Content | Hash | Result | Tier | Anchor |",
      "| --- | --- | --- | --- | --- |",
    ];
    for (const r of results) {
      lines.push(
        `| ${r.file ?? "(run)"} | ${r.contentHash ? shortHash(r.contentHash) : ""} | ${r.status}${r.reason ? `: ${r.reason}` : ""}${r.error ? `: ${r.error}` : ""} | ${r.tier ?? ""} | ${r.anchorStatus ?? ""} |`,
      );
    }
    if (dryRun) lines.push("", "Dry run: seals were computed with an ephemeral key and nothing was recorded.");
    if (anchorPending.length > 0) lines.push("", `${anchorPending.length} seal(s) published unanchored; see the seal-anchor-pending tracking issue.`);
    return { ok, results, summaryMarkdown: lines.join("\n") + "\n", anchorPending };
  }
}

// CLI: node action/seal-run.mjs --root DIR --config FILE --mode publish|dry-run
//     [--files-from FILE] [--key-file FILE]
// The sealing key comes from --key-file (the workflow materialises
// it mode-600 and destroys it after) or SIGNET_SEALING_PRIVATE_KEY.
async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const root = value("--root") ?? process.cwd();
  const config = JSON.parse(await readFile(value("--config") ?? join(root, "signet.config.json"), "utf8"));
  const mode = value("--mode") ?? "publish";
  let files = null;
  const filesFrom = value("--files-from");
  if (filesFrom) {
    files = (await readFile(filesFrom, "utf8")).split("\n").map((s) => s.trim()).filter(Boolean);
  }

  let signer = null;
  if (mode !== "dry-run") {
    const keyFile = value("--key-file");
    const key = keyFile ? (await readFile(keyFile, "utf8")).trim() : process.env.SIGNET_SEALING_PRIVATE_KEY;
    if (!key) {
      console.error("publish mode needs --key-file or SIGNET_SEALING_PRIVATE_KEY");
      process.exit(2);
    }
    signer = new PrivateKeySigner(key.startsWith("0x") ? key : "0x" + key);
  }

  const anchorFn = config.anchor?.command ? commandAnchorFn(config.anchor.command) : null;
  const outcome = await runSealing({ root, config, mode, files, signer, anchorFn });
  console.log(outcome.summaryMarkdown);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await writeFile(summaryPath, outcome.summaryMarkdown, { flag: "a" });
  const outPath = join(root, config.sealsDir ?? "_seals", "run-summary.json");
  if (mode !== "dry-run" && outcome.ok) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(outcome.results, null, 2) + "\n");
  }
  process.exit(outcome.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
