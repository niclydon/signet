// Walk the verify page's ES module graph applying the importmap
// rules from verify/index.html, and assert every specifier
// resolves to a real file. Browsers do no extension searching, so
// an unmapped or extensionless specifier in the vendored @noble
// trees is a page that fails at load; this check catches that class
// in CI instead. Run: node scripts/check-verify-graph.mjs

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const html = await readFile(resolve(root, "verify/index.html"), "utf8");
const mapJson = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const imports = JSON.parse(mapJson).imports;

function mapSpecifier(spec, fromDir) {
  if (spec.startsWith("./") || spec.startsWith("../")) return resolve(fromDir, spec);
  if (imports[spec]) return resolve(root, "verify", imports[spec]);
  for (const [key, value] of Object.entries(imports)) {
    if (key.endsWith("/") && spec.startsWith(key)) {
      return resolve(root, "verify", value + spec.slice(key.length));
    }
  }
  throw new Error("unmapped specifier: " + spec);
}

const seen = new Set();
async function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!existsSync(file)) throw new Error("missing file: " + file);
  const text = await readFile(file, "utf8");
  const dir = dirname(file);
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    await walk(mapSpecifier(m[1], dir));
  }
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    await walk(mapSpecifier(m[1], dir));
  }
}

await walk(resolve(root, "verify/browser-providers.js"));
await walk(resolve(root, "src/verify.js"));
console.log(`verify page module graph OK: ${seen.size} files resolved`);
