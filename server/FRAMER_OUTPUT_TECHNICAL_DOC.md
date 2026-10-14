# Framer Output — Technical Approach & Implementation Plan

> **Status:** Proposal for supervisor review
> **Author:** Dev team
> **Date:** 2026-10-12
> **Related files:** `server/rules/ELEMENTOR_SKILL.md`, `server/rules/FRAMER.md`, `server/src/modules/rules/rule-loader.ts`, `server/src/modules/capabilities/capabilities.schema.ts`

---

## 1. Executive summary (the question we are answering)

**Supervisor's question:** *"After converting to Framer, what do we download — a JSON file like Elementor's template, or something else? Does Framer support importing JSON the way Elementor does?"*

**Short answer:**

| Platform | Native "download file → import" flow? | Our output |
|---|---|---|
| **Elementor** | ✅ Yes — WordPress → *Templates → Saved Templates → Import* accepts a **JSON template**. | A single **Elementor JSON document** (`{ title, type, version, page_settings, content[] }`). This already works in our pipeline. |
| **Framer** | ❌ **No** — Framer has **no "import a JSON template" slot**. Its supported ingestion paths are: Figma **plugin → paste**, browser **extension → paste**, and **CSV → CMS** (content data only, not layout). | A **Framer node JSON** (our intermediate design mapped to Framer layer attributes) **plus a companion Framer plugin** that reads that JSON and rebuilds the layout on the Framer canvas. |

**Conclusion:** For Framer we cannot ship "just a downloadable JSON like Elementor." The faithful equivalent is **JSON output + a custom Framer plugin** built on Framer's **Plugin API** (`framer.createFrameNode`, `framer.createTextNode`, …), which constructs the canvas programmatically from our JSON. This is the recommended approach (Option A).

---

## 2. How our current pipeline works

Our conversion is a **Source → DIR → Target** pipeline, driven by Markdown rule files (no hardcoded logic):

```
┌──────────────┐    FIGMA.md / FRAMER.md     ┌──────────────┐   ELEMENTOR_SKILL.md   ┌───────────────┐
│  Design      │  ─────────────────────────▶  │  Canonical   │  ────────────────────▶ │  Target JSON  │
│  source      │   (source analysis rules)     │  DIR (IR)    │   (target rules)        │  (Elementor)  │
└──────────────┘                              └──────────────┘                         └───────────────┘
```

- **Canonical DIR shape** (defined by the source rules): `version`, `meta`, `breakpoints`, `globals`, `assets`, `pages[].sections[].children[]`.
- **DIR node kinds:** `heading`, `text`, `button`, `image`, `iconBox`, `nav`, `form`, `container`.
- **Rule loader** (`rule-loader.ts`) loads the source rule + **one** target rule (`ELEMENTOR_SKILL.md`) at conversion time and composes the trusted system instructions. Target is currently **hardcoded to Elementor** in `capabilities.schema.ts` (`platform: z.literal("elementor")`).

The elegant part: adding a new target is a matter of adding a **new target rule file** + widening the schema + adding a download/render adapter. We are **not** redesigning the DIR.

---

## 3. Research findings — what Framer actually accepts

**Official Framer ingestion mechanisms (verified against Framer docs):**

1. **Figma → Framer:** Official *Figma to HTML with Framer* plugin. Select layers in Figma → copy → **paste onto the Framer canvas**. Layers arrive as **editable** Framer nodes.
2. **Web → Framer:** Framer **browser extension** copies a section from a live page → paste into a Framer project.
3. **CMS content:** **CSV import** into a CMS Collection (structured content/data). Third-party *JSON Sync* plugins exist but only touch **CMS collections**, not canvas layout.
4. **Plugin API (programmatic):** Framer Plugins can **add and manipulate any layer on the Canvas**. Core functions include:
   - `framer.createFrameNode(attributes, parentId)` → new frame/box node
   - `framer.createTextNode(attributes, parentId)` → new text layer
   - `framer.createSVGNode(...)` → SVG layer
   - `node.addChild(childNode)` → nesting / hierarchy
   - `framer.getNode`, `framer.getSelection`, `framer.getNodesWithType(...)` → read existing canvas

**Key takeaway:** There is **no JSON-template import slot** in Framer, but the **Plugin API gives us full programmatic control of the canvas**. So we produce a **Framer-specific JSON** and let a **companion plugin** render it — functionally equivalent to Elementor's JSON import, just via a different delivery mechanism.


---

## 4. Proposed architecture — Framer output branch

We extend the existing pipeline with a second target branch. **Nothing about the DIR changes.**

```
                        ┌─────────────────────────────┐
   source ──rules──▶     │      Canonical DIR (IR)      │
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┴─────────────────────────┐
              ▼                                                   ▼
   ELEMENTOR_SKILL.md                                  FRAMER_SKILL.md          (NEW)
              ▼                                                   ▼
   Elementor JSON                                       Framer Node JSON          (NEW)
   { content[], elType, settings }                      { version, pages[], nodes[] }
              │                                                   │
     Elementor import slot                          ┌─────────────┴──────────────┐
     (download → import)                            ▼                            ▼
                                          framer-plugin (NEW)          Optional: copy-to-clipboard
                                          reads JSON → builds canvas   (Framer paste, later)
```

### 4.1 New target rule file — `server/rules/FRAMER_SKILL.md`

A Markdown rulebook **analogous to `ELEMENTOR_SKILL.md`**, but producing a **Framer node document** instead of Elementor JSON. It will contain the deterministic **DIR node-kind → Framer attribute mapping** (Section 5). This keeps our "rules live in Markdown, not in TypeScript" principle.

### 4.2 New intermediate document — "Framer Node JSON"

The plugin's input format. It is **our own portable schema** (not Framer's binary project format — Framer does not expose one for import). Shape:

```json
{
  "version": "1.0.0",
  "meta": { "sourceType": "figma|framer|react-next-zip", "generatedAt": "..." },
  "breakpoints": [ ... ],
  "globals": { "colors": {}, "fonts": {} },
  "assets": [ { "id": "...", "src": "...", "alt": "..." } ],
  "pages": [
    {
      "name": "Home",
      "root": {
        "id": "n1",
        "kind": "frame",
        "name": "Hero Section",
        "layout": { "direction": "vertical", "gap": 24, "padding": {...}, "width": 1200, "background": "#ffffff" },
        "children": [
          { "id": "n2", "kind": "text", "name": "Headline", "text": "...", "style": { "font": "Inter", "size": 48, "weight": 700, "color": "#111111" } },
          { "id": "n3", "kind": "image", "name": "Hero Image", "assetId": "a1", "layout": { "width": 600, "height": 400 } }
        ]
      }
    }
  ]
}
```

### 4.3 The companion Framer plugin — `framer-plugin/`

A standalone Framer plugin (TypeScript + Framer Plugin API + React UI) that:
1. Lets the user **paste or upload** the downloaded Framer Node JSON.
2. Walks the JSON tree and calls `framer.createFrameNode` / `framer.createTextNode` / `framer.createSVGNode` to **rebuild the layout on the canvas**, preserving hierarchy, layout, and styles.
3. Reports a **conversion report** (what rendered, what was unsupported) back to the user — mirroring our Elementor diagnostics honesty model.

Plugin workflow from the user's side:

```
1. In our app: choose target = Framer → convert → Download "site.framer.json"
2. Open Framer project → Plugins → Our Plugin → paste/upload site.framer.json
3. Plugin rebuilds the design as editable Framer layers on the canvas
4. Review diagnostics, then edit/publish in Framer normally
```

---

## 5. DIR node-kind → Framer mapping (goes into `FRAMER_SKILL.md`)

Deterministic, lossless-where-possible mapping. Same DIR node kinds as Elementor uses.

| DIR kind | Framer node | Attributes set (examples) |
|---|---|---|
| `container` | `FrameNode` | `layout: "stack"`, `direction`, `gap`, `padding`, `backgroundColor`, `size`, `radius` |
| `heading` | `TextNode` (inside a frame) | text content, `font`, `fontSize`, `fontWeight`, `color`, `lineHeight` |
| `text` | `TextNode` | text content + text style |
| `button` | `FrameNode` + `TextNode` | frame fill/radius + text; attach link if DIR carries `link.url` |
| `image` | `FrameNode` with image fill / asset | image `src` (from DIR asset), `objectFit`, `size` |
| `iconBox` | `FrameNode` (icon + text stack) | icon (SVG asset) + title + description |
| `nav` | `FrameNode` row of link frames | preserve items, links |
| `form` | `FrameNode` of labeled input frames | fields; note: interactive Framer forms may need a form plugin — record diagnostic |

**Honesty rules (carried over from Elementor rules):** copy text verbatim; never invent content; only add links/interactions the DIR actually carries; record every unsupported feature as a structured diagnostic instead of faking it.

---

## 6. Implementation plan (phased)

### Phase 1 — Schema & rules (backend, no behavior change to Elementor)
- [ ] Widen `capabilities.schema.ts`: `targetProfile.platform` → `z.enum(["elementor", "framer"])` (keep Elementor validation intact).
- [ ] Add `targetStatus`/architecture metadata so the UI can show "Framer output" as available.
- [ ] Update `rule-loader.ts` `RULE_FILES` to resolve target rule by platform: `elementor → ELEMENTOR_SKILL.md`, `framer → FRAMER_SKILL.md`.
- [ ] Author `server/rules/FRAMER_SKILL.md` (Section 5 mapping + output contract).

### Phase 2 — Framer Node JSON compiler
- [ ] Implement a deterministic **DIR → Framer Node JSON** compiler (TS) mirroring the Elementor compiler's structure.
- [ ] Emit `site.framer.json` as the downloadable artifact (store in artifact storage; reuse the existing `Artifact` model + download authorization flow).
- [ ] Validation + diagnostics report (reuse `ValidationReport`).

### Phase 3 — Companion Framer plugin
- [ ] Scaffold `framer-plugin/` (Framer plugin template, TS + React).
- [ ] Implement JSON paste/upload → canvas rebuild using `createFrameNode` / `createTextNode` / `createSVGNode` / `addChild`.
- [ ] Render diagnostics UI; handle unsupported nodes gracefully.
- [ ] Test against sample converted JSON.

### Phase 4 — UX wiring & docs
- [ ] Client: add "Framer" to target selection; show the two-step instructions (Download JSON → run plugin).
- [ ] Document both targets in `README.md` / `SYSTEM_ARCHITECTURE.md`.
- [ ] Ship plugin (Framer marketplace or bundled) + link it from the download screen.

### (Optional) Phase 5 — Copy-to-clipboard
- [ ] Add a "Copy for Framer" button that writes the JSON to clipboard, mimicking Framer's own Figma-paste flow. Lower priority; more fragile than the plugin path.

---

## 7. Files to create / modify (checklist)

**New files**
- `server/rules/FRAMER_SKILL.md` — DIR → Framer rulebook
- `server/src/modules/targets/framer/framer.compiler.ts` — DIR → Framer Node JSON
- `server/src/modules/targets/framer/framer.schema.ts` — Framer Node JSON schema + validation
- `framer-plugin/…` — the companion plugin (standalone repo/folder)

**Modified files**
- `server/src/modules/capabilities/capabilities.schema.ts` — allow `platform: "framer"`
- `server/src/modules/rules/rule-loader.ts` — resolve target rule by platform
- Client target-selection UI (`client/features/conversions/ConversionSettings.tsx`, project form)
- `README.md`, `SYSTEM_ARCHITECTURE.md`

---

## 8. Why this is the right approach

1. **Faithful to Framer reality.** We are not pretending Framer has a JSON import slot that doesn't exist. We use the mechanism Framer *does* expose (Plugin API) to achieve the same end result.
2. **Minimal blast radius.** The DIR is untouched. We add a parallel target branch, so the working Elementor path stays exactly as-is.
3. **Consistent with our architecture.** New logic lives in a Markdown rule + a compiler module + a plugin — not scattered hardcoded rules.
4. **Honest diagnostics.** Same "never invent, always report" contract we already hold for Elementor.

---

## 9. Open questions for supervisor

1. **Plugin distribution:** Publish to the Framer Plugin marketplace, or bundle/install manually for our employees?
2. **Scope of fidelity:** Full layout + styles rebuild (recommended), or a lighter "sections only" first release?
3. **Ownership:** Who builds & maintains the Framer plugin — our team, or is there an existing Framer-side owner?
4. **CMS content:** Do we also push text/data into Framer CMS (CSV), or keep everything as canvas layers in v1?

