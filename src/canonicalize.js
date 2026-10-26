// w3-text-v1 canonicalisation, per SPEC.md section 4.1.
//
// Rules, applied in this order:
//   1. Input is text decoded as UTF-8. A single leading U+FEFF (BOM)
//      is removed; a BOM anywhere else is content.
//   2. Unicode normalisation form NFC.
//   3. Line endings: CRLF and lone CR become LF.
//   4. Trailing spaces and tabs are stripped from each line.
//   5. Trailing empty lines are dropped and the text ends with a
//      single LF. (Empty input, or input that is only blank lines,
//      canonicalises to zero bytes, and that case is in the vectors.)
// Nothing else is touched: zero-width characters, leading
// whitespace, and interior blank lines are content and are hashed.
//
// The canonical form is the committed source text, never rendered
// HTML. Surface front-matter handling lives in splitFrontMatter and
// is the calling surface's choice, per SPEC.md sections 4.1 and 10.

import { sha256Prefixed, utf8 } from "./util.js";

export const C14N_ID = "w3-text-v1";

/**
 * Canonicalise a string to its w3-text-v1 form.
 * Returns the canonical string; use canonicalBytes for the exact
 * bytes that are hashed.
 */
export function canonicalizeText(input) {
  if (typeof input !== "string") {
    throw new TypeError("canonicalizeText: input must be a string");
  }
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.normalize("NFC");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return "";
  return lines.join("\n") + "\n";
}

/** Canonical bytes (UTF-8) for a string input. */
export function canonicalBytes(input) {
  return utf8(canonicalizeText(input));
}

/** Canonicalise raw UTF-8 bytes (for example a file read from disk). */
export function canonicalBytesFromBuffer(buffer) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  return canonicalBytes(text);
}

/** Content hash in seal form: "sha256:<hex>" over the canonical bytes. */
export function contentHash(input) {
  return sha256Prefixed(canonicalBytes(input));
}

/**
 * Minimal front-matter split for the static-site surfaces in SPEC
 * section 10: a leading block delimited by lines of exactly "---".
 * Returns { frontMatter: string|null, body: string }. This is a
 * surface helper, not part of w3-text-v1 itself: which parts are
 * hashed is the surface config's decision.
 */
export function splitFrontMatter(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontMatter: null, body: text };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontMatter: null, body: text };
  }
  return {
    frontMatter: normalized.slice(4, end + 1),
    body: normalized.slice(end + 5),
  };
}

/** Extract a simple "key: value" field from the front-matter block. */
export function frontMatterField(frontMatter, key) {
  if (frontMatter == null) return null;
  for (const line of frontMatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match && match[1] === key) {
      const value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        return value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}
