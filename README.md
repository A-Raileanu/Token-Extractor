# Token Extractor

Extracts design tokens from a Figma file and converts them into CSS custom properties.

---

## Setup

1. **Clone / download** this folder
2. Ensure you have **Node.js 20.6+** installed (no `npm install` needed — zero dependencies)
3. Add your Figma personal access token to the `.env` file:

```
FIGMA_TOKEN=your_token_here
```

You can generate a token in Figma under **Account Settings → Personal access tokens**.

---

## Running the script

```bash
node --env-file=.env extract.js
```

Output files are written to `./output/`.

### Optional flags

| Flag | Default | Description |
|------|---------|-------------|
| `--file-key=XXXX` | `HHqZsz18PO50YqqvOKaIfi` | Override the Figma file key |
| `--output=./path` | `./output` | Override the output directory |

Example:
```bash
node --env-file=.env extract.js --file-key=AbCdEfGh --output=./tokens
```

---

## Output structure

```
output/
  index.css                      ← imports all files in the correct order
  primitives.css                 ← raw values (colors, font sizes, spacing…)
  semantics.css                  ← semantic aliases (e.g. --color-primary)
  mall-of-semantics.css          ← Mall Of brand overrides for semantic tokens
  share-semantics.css            ← Share brand overrides for semantic tokens
  typography.css                 ← typography tokens (font, size, weight…)
  mall-of-typography.css         ← Mall Of brand overrides for typography
  share-typography.css           ← Share brand overrides for typography
```

`index.css` loads files in dependency order — primitives first, then semantics (which reference primitives), then typography last.

---

## How the script works

### 1. Fetch variables from the Figma API

The script calls:

- `GET /v1/files/{fileKey}/variables/local` — all variables defined in the file

### 2. Handle extended collections

Figma supports **extended collections** — collections that inherit the same variables as a base collection but add brand-specific mode groupings (e.g. "Mall Of" extends "Semantics" to provide brand overrides).

These are identified by the `isExtension: true` flag on the collection. Their modes carry a `parentModeId` field that points to the actual key inside each variable's `valuesByMode` map.

### 3. Build CSS variable names

Variable names follow the Figma path directly, converted to kebab-case:

```
color/base/black  →  --color-base-black
heading/font      →  --heading-font
```

No collection name prefix is added.

### 4. Resolve aliases

When a variable's value is a reference to another variable (`VARIABLE_ALIAS`), the script resolves it to a CSS `var()` reference:

```css
--color-primary: var(--color-global-blue-500);
```

### 5. Convert values

| Figma type | CSS output |
|------------|------------|
| `COLOR` (opaque) | `#rrggbb` |
| `COLOR` (transparent) | `rgba(R, G, B, A)` |
| `FLOAT` | plain number |
| `STRING` | `"value"` |
| `BOOLEAN` | `1` or `0` |

### 6. Handle multiple modes

Each collection can have multiple modes (e.g. English / Arabic, Light / Dark).

- **First mode** → output under `:root { }`
- **Additional modes** → output under `[data-theme="mode-name"] { }`

### 7. Filter out stale remote collections

Collections marked `remote: true` are references to external libraries that may no longer exist. These are skipped to keep the output clean.

### 8. Write output files

One CSS file is generated per collection. `index.css` imports them all in the correct cascade order:

1. `primitives.css` — raw tokens, no dependencies
2. `semantics.css` — references primitives
3. Semantics extensions — brand overrides for semantic tokens
4. `typography.css` — references primitives
5. Typography extensions — brand overrides for typography tokens
