# ProvenanceSeal (`<agent-seal>`)

The seal's visible form, as specified in section 8 of the design
spec. One component, three densities, two tier states, four
verification states. No surface may fork its markup or copy.

## Use

```html
<script type="module" src="/components/ProvenanceSeal/provenance-seal.js"></script>

<agent-seal
  content-hash="sha256:..."
  verify-url="https://example.com/verify/..."
  persona="Nova"
  tier="not-approved"
  timing-basis="signer-claimed"
  sealed-at="2026-10-26T12:00:00Z"
  surface="personal-website"
  density="full"
></agent-seal>
```

## Props

| Attribute | Values | Notes |
| --- | --- | --- |
| `content-hash` | `sha256:...` | Required. Shown shortened (first 8, last 4). |
| `verify-url` | URL | Required. The canonical `/verify/<hash>` URL; the durable part of the component. |
| `persona` | text | Required. The agent persona named in the seal. |
| `tier` | `approved` / `not-approved` | Required. Structural: filled mark plus "approved", outline mark plus "not approved". Every density carries the tier word, the pill included. |
| `timing-basis` | `world-chain-anchor` / `signer-claimed` | Required. The meta line labels the date anchored or claimed accordingly. |
| `sealed-at` | ISO timestamp | Required. |
| `anchor-time` | ISO timestamp | Optional; used for the date when `timing-basis` is the anchor. |
| `state` | `live-verified` / `sealed-unchecked` / `superseded` / `check-failed` | Defaults to `sealed-unchecked`: a static render has not run a live check, and its wording says so ("Seal recorded. Live status on the verify page."). A host that runs the verify page's checks updates `state` afterwards. |
| `density` | `full` / `compact` / `pill` | `full` is the article footer and the only variant allowed as the sole seal on a long-form post. `compact` is for release notes and lists. `pill` is the one-line inline form. |
| `surface` | text | Optional; shown on the full meta line. |
| `current-verify-url` | URL | For the `superseded` state: the current version's verify link. Superseded content keeps its seal; removing it is forbidden. |

## Tokens

The component consumes design tokens only, as CSS variables the
host sets from its compiled aesthetic: `--seal-surface`,
`--seal-border`, `--seal-label`, `--seal-accent`, `--seal-muted`,
`--seal-danger`, `--seal-ink`. The built-in defaults are the true
Nova Glass values: graphite `#1C1C1E`, glass `rgba(28,28,30,.78)`
with blur, cerulean `#4A7FA5`, label cyan `#8ABAD3`, gold-amber
`#C9933A`, 45-degree cut corners, no gradients. A light aesthetic
re-skins the component by setting the variables; the structure
does not change.

## Mosvera registration

`template.provenance-seal.json` is the component's Mosvera
template document: the token binding above in the registry's
standard sections, plus the component contract (element, props,
densities, rules) under `extensions.component`.
`composition.provenance-seal.json` binds it as the default
composition. Both are registered in the live registry under the
id `provenance-seal`.

The registry's `dark-nova-glass` composition previously compiled
to another aesthetic's tokens entirely; it now carries the true
Nova Glass palette as composition overrides (see the template
above), which is the correction the design spec called for.

## Rules the component enforces

- State is never carried by colour alone; tier and state are
  available as text, including to screen readers.
- The tier difference is structural (filled versus outline mark)
  as well as verbal.
- The component contains no human identifier in any form, raw or
  hashed, and no World logo, official badge, or endorsement
  wording. The human hash, when shown at all, belongs on the
  verify page, next to the live check that produced it and its
  check time.
