// Vendor the library's two @noble dependencies into verify/vendor/
// so the static verify page can be served from any static host with
// no build step and no CDN dependency. Run after npm install:
//   node scripts/vendor-deps.mjs
// The vendored copies are the exact installed versions (see
// package-lock.json); their licenses ship inside each package.

import { cp, rm } from "node:fs/promises";

const target = new URL("../verify/vendor/@noble", import.meta.url);
await rm(new URL("../verify/vendor", import.meta.url), { recursive: true, force: true });
await cp(new URL("../node_modules/@noble", import.meta.url), target, { recursive: true });
console.log("vendored @noble into verify/vendor/@noble");
