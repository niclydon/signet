// ProvenanceSeal, invoked as <agent-seal>: the seal's visible
// form (design SPEC section 8). One component, three densities,
// two tier states, four verification states. No surface may fork
// its markup or copy; surfaces set attributes and host the
// component as-is.
//
// The component consumes design tokens only, as CSS variables set
// by the host's compiled aesthetic:
//   --seal-surface, --seal-border, --seal-label, --seal-accent,
//   --seal-muted, --seal-danger, --seal-ink
// The defaults baked in below are the true Nova Glass values
// (graphite #1C1C1E, glass rgba(28,28,30,.78), cerulean #4A7FA5,
// label cyan #8ABAD3, gold-amber #C9933A, 45-degree cut corners,
// no gradients), so the component is correct before any aesthetic
// is compiled over it, and a light aesthetic re-skins it by
// setting the variables.
//
// Rules carried from the spec, enforced here:
// - A static render has not run a live check, so the default state
//   is sealed-unchecked and its wording says exactly that. Hosts
//   that run the verify-page checks set `state` (and show the
//   check time on the verify page) afterwards.
// - The tier is structural, never colour alone: approved uses a
//   filled mark and the word "approved"; not-approved uses an
//   outline mark and the words "not approved". Every density,
//   including the pill, carries the tier word.
// - Superseded content keeps its seal and links to the current
//   version's seal. Removing it is forbidden.
// - The component carries no human identifier in any form, raw or
//   hashed. The verify link is the durable part.

export const SEAL_STATES = ["live-verified", "sealed-unchecked", "superseded", "check-failed"];
export const SEAL_TIERS = ["approved", "not-approved"];
export const SEAL_DENSITIES = ["full", "compact", "pill"];

export function shortHash(hash) {
  const hex = String(hash ?? "").replace(/^sha256:/, "");
  if (hex.length <= 12) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().slice(0, 10);
}

/**
 * The pure line model for a seal rendering. The element below is a
 * thin shell over this model, which is what the tests exercise.
 *
 * props: { contentHash, verifyUrl, persona, tier, timingBasis,
 *          sealedAt, anchorTime?, state?, density?, surface?,
 *          currentVerifyUrl? }
 */
export function sealLines(props) {
  const tier = SEAL_TIERS.includes(props.tier) ? props.tier : "not-approved";
  const state = SEAL_STATES.includes(props.state) ? props.state : "sealed-unchecked";
  const density = SEAL_DENSITIES.includes(props.density) ? props.density : "full";
  const approved = tier === "approved";
  const timingLabel =
    props.timingBasis === "world-chain-anchor"
      ? `anchored ${formatDate(props.anchorTime ?? props.sealedAt)}`
      : `claimed ${formatDate(props.sealedAt)}`;

  const model = {
    density,
    tier,
    state,
    markVariant: approved ? "filled" : "outline",
    markWord: density === "full" ? "Provenance seal" : "Sealed",
    tierWord: approved ? "approved" : "not approved",
    verifyUrl: props.verifyUrl,
    lines: [],
  };

  if (density === "pill") {
    model.lines.push(
      `Sealed · ${model.tierWord} · ${shortHash(props.contentHash)}`,
    );
    return model;
  }

  model.lines.push(`Written by agent ${props.persona}. Backed by a unique verified human.`);
  model.lines.push(
    density === "full"
      ? `Human approved: ${approved ? "yes" : "no"}`
      : `Approved: ${approved ? "yes" : "no"}`,
  );
  if (density === "full") {
    const meta = [`Sealed ${timingLabel}`, shortHash(props.contentHash)];
    if (props.surface) meta.push(props.surface);
    model.lines.push(meta.join(" · "));
  } else {
    model.lines.push(shortHash(props.contentHash));
  }

  if (state === "sealed-unchecked") {
    model.lines.push("Seal recorded. Live status on the verify page.");
  } else if (state === "live-verified") {
    model.lines.push("Live status verified. Details on the verify page.");
  } else if (state === "superseded") {
    model.lines.push("This version is superseded. The current version's seal is linked below.");
    if (props.currentVerifyUrl) model.currentVerifyUrl = props.currentVerifyUrl;
  } else if (state === "check-failed") {
    model.lines.push("The last live check did not pass. Details on the verify page.");
  }
  return model;
}

const MARK_PATHS = {
  filled:
    '<circle cx="16" cy="16" r="13" fill="var(--seal-accent)" fill-opacity="0.18" stroke="var(--seal-accent)" stroke-width="2"/><circle cx="16" cy="16" r="5.5" fill="var(--seal-accent)"/>',
  outline:
    '<circle cx="16" cy="16" r="13" fill="none" stroke="var(--seal-label)" stroke-width="2"/><circle cx="16" cy="16" r="5.5" fill="none" stroke="var(--seal-label)" stroke-width="2"/>',
};

const STYLE = `
:host {
  --seal-surface: rgba(28, 28, 30, 0.78);
  --seal-border: #4a7fa5;
  --seal-label: #8abad3;
  --seal-accent: #c9933a;
  --seal-muted: #9a9aa0;
  --seal-danger: #d66a5e;
  --seal-ink: #f2f2f4;
  display: block;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: var(--seal-ink);
}
.seal {
  background: var(--seal-surface);
  border: 1px solid var(--seal-border);
  clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px);
  backdrop-filter: blur(10px);
  padding: 14px 16px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.seal[data-density="pill"] { padding: 6px 10px; align-items: center; }
.seal[data-state="check-failed"] { border-color: var(--seal-danger); }
.mark { flex: none; display: flex; align-items: center; gap: 8px; }
.mark .word { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--seal-label); }
.body { font-size: 14px; line-height: 1.45; }
.body p { margin: 0 0 4px; }
.body .meta { color: var(--seal-muted); font-size: 12.5px; font-family: ui-monospace, monospace; }
.body .state { color: var(--seal-label); font-size: 12.5px; }
.seal[data-state="check-failed"] .state { color: var(--seal-danger); }
a { color: var(--seal-accent); text-decoration: none; font-size: 13px; }
a:hover { text-decoration: underline; }
.pill-line { font-size: 12.5px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

export function renderSealHtml(props) {
  const model = sealLines(props);
  const paragraphs = model.lines
    .map((line, i) => {
      const cls = i === model.lines.length - 1 && model.density !== "pill" ? ' class="state"' : "";
      return `<p${cls}>${escapeHtml(line)}</p>`;
    })
    .join("");
  const srText = `Provenance seal. Tier: ${model.tierWord}. State: ${model.state}.`;
  if (model.density === "pill") {
    return `<div class="seal" data-density="pill" data-state="${model.state}">
      <span class="mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 32 32">${MARK_PATHS[model.markVariant]}</svg></span>
      <span class="pill-line">${escapeHtml(model.lines[0])}</span>
      <a href="${escapeAttr(model.verifyUrl)}">Verify this seal</a>
      <span class="sr-only">${escapeHtml(srText)}</span>
    </div>`;
  }
  const links = [`<a href="${escapeAttr(model.verifyUrl)}">Verify this seal</a>`];
  if (model.currentVerifyUrl) {
    links.push(`<a href="${escapeAttr(model.currentVerifyUrl)}">Current version's seal</a>`);
  }
  return `<div class="seal" data-density="${model.density}" data-state="${model.state}">
    <span class="mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 32 32">${MARK_PATHS[model.markVariant]}</svg><span class="word">${escapeHtml(model.markWord)}</span></span>
    <div class="body">${paragraphs}<p>${links.join(" · ")}</p></div>
    <span class="sr-only">${escapeHtml(srText)}</span>
  </div>`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined") {
  class AgentSeal extends HTMLElement {
    static get observedAttributes() {
      return [
        "content-hash", "verify-url", "persona", "tier", "timing-basis",
        "sealed-at", "anchor-time", "state", "density", "surface",
        "current-verify-url",
      ];
    }
    connectedCallback() {
      this.render();
    }
    attributeChangedCallback() {
      this.render();
    }
    render() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      const props = {
        contentHash: this.getAttribute("content-hash") ?? "",
        verifyUrl: this.getAttribute("verify-url") ?? "#",
        persona: this.getAttribute("persona") ?? "",
        tier: this.getAttribute("tier") ?? "not-approved",
        timingBasis: this.getAttribute("timing-basis") ?? "signer-claimed",
        sealedAt: this.getAttribute("sealed-at") ?? "",
        anchorTime: this.getAttribute("anchor-time") ?? undefined,
        state: this.getAttribute("state") ?? "sealed-unchecked",
        density: this.getAttribute("density") ?? "full",
        surface: this.getAttribute("surface") ?? undefined,
        currentVerifyUrl: this.getAttribute("current-verify-url") ?? undefined,
      };
      this.shadowRoot.innerHTML = `<style>${STYLE}</style>${renderSealHtml(props)}`;
    }
  }
  if (!customElements.get("agent-seal")) {
    customElements.define("agent-seal", AgentSeal);
  }
}
