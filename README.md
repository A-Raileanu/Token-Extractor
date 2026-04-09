# Token Extractor

Extracts design tokens and local styles from a Figma file and converts them into CSS custom properties and utility classes.

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
  index.css                      ← imports all token files in the correct order
  primitives.css                 ← raw values (colors, font sizes, spacing…)
  semantics.css                  ← semantic aliases (e.g. --color-primary)
  mall-of-semantics.css          ← Mall Of brand overrides for semantic tokens
  share-semantics.css            ← Share brand overrides for semantic tokens
  typography.css                 ← typography tokens (font, size, weight…)
  mall-of-typography.css         ← Mall Of brand overrides for typography
  share-typography.css           ← Share brand overrides for typography
  styles.css                     ← utility classes for all Figma text & effect styles
```

`index.css` loads token files in dependency order — primitives first, then semantics, then typography. `styles.css` is standalone and references the token variables defined in the other files.

---

## How the script works

### 1. Fetch variables from the Figma API

The script calls:

- `GET /v1/files/{fileKey}/variables/local` — all variables defined in the file
- `GET /v1/files/{fileKey}/styles` — all local text and effect styles
- `GET /v1/files/{fileKey}/nodes?ids=…` — node data for effect styles (to read effect values)

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

When a variable's value is a reference to another variable (`VARIABLE_ALIAS`), the script either:

- Outputs a CSS `var()` reference (default behaviour), or
- Follows the alias chain to the terminal value and outputs it directly (for OKLCH color conversion and rem conversion — see below)

### 5. Convert values

| Figma type | Collection | CSS output |
|------------|------------|------------|
| `COLOR` | Primitives | `#rrggbb` / `rgba()` |
| `COLOR` | Semantics & all non-primitives | `oklch(L C H)` / `oklch(L C H / A)` — resolved from alias chain |
| `FLOAT` (spacing, border, rounded, font-size, line-height, letter-spacing, effects/blur, effects/position, effects/spread) | Primitives | plain number |
| `FLOAT` (size/, border/, radius/) | Semantics | `Xrem` — resolved from alias chain and divided by 16 |
| `FLOAT` (per-style size, line-height, spacing) | Typography | `Xrem` — resolved from alias chain and divided by 16 |
| `FLOAT` (everything else) | Any | plain number |
| `STRING` | Any | `"value"` |
| `BOOLEAN` | Any | `1` or `0` |

#### OKLCH color conversion

Colors in semantic collections are resolved through the alias chain to their terminal `{r, g, b, a}` value and converted to `oklch()` using the Björn Ottosson Oklab matrices (sRGB → linearise → LMS → Oklab → OKLCH). This enables perceptually-uniform colour manipulation in consuming code.

#### Rem conversion

Numeric pixel values in the semantics and typography collections (spatial tokens and font-size / line-height / letter-spacing) are resolved through the alias chain and divided by 16 to produce `rem` values.

### 6. Group primitives.css

Variables in the primitives collection are sorted and grouped into six sections with section banners:

```
COLOR → FONT → SPACING → BORDER → ROUNDED → EFFECTS
```

### 7. Handle multiple modes

Each collection can have multiple modes (e.g. English / Arabic, Light / Dark).

- **First mode** → output under `:root { }`
- **Additional modes** → output under `[data-theme="mode-name"] { }`

### 8. Filter out stale remote collections

Collections marked `remote: true` are references to external libraries that may no longer exist. These are skipped to keep the output clean.

### 9. Write token output files

One CSS file is generated per collection. `index.css` imports them all in the correct cascade order:

1. `primitives.css` — raw tokens, no dependencies
2. `semantics.css` — references primitives
3. Semantics extensions — brand overrides for semantic tokens
4. `typography.css` — references primitives
5. Typography extensions — brand overrides for typography tokens

### 10. Generate styles.css

The script reads all local Figma styles and generates `styles.css` containing:

#### Text styles

CSS utility classes are created for each text style, referencing typography token variables. The class naming follows these rules:

| Figma style name | CSS class | Notes |
|------------------|-----------|-------|
| `paragraph/xxs` | `.paragraph-xxs` | Uses `--paragraph-xxs-*` vars |
| `paragraph/sm-strong` | `.paragraph-sm-strong` | Uses base vars + `--paragraph-sm-weight-strong` |
| `subhead/mobile/sm` | `.subhead-sm` | Uses `--subhead-mobile-sm-*` vars |
| `heading/mobile/sm` + `heading/desktop/sm` | `.heading-sm` | Responsive — mobile values as base, desktop values inside `@media (min-width: 768px)` |

#### Effect styles

CSS utility classes are created for each effect style:

| Figma style name | CSS class |
|------------------|-----------|
| `shadow/raised` | `.shadow-raised` |
| `blur/base` | `.blur-base` |
| `liquid-glass/base` | `.liquid-glass-base` |

**Uniform blurs** output a direct `backdrop-filter: blur()` or `filter: blur()` declaration.

**Progressive blurs** (Figma `blurType: "PROGRESSIVE"`) output a `::after` pseudo-element with `backdrop-filter` and a `mask-image` gradient, computed from the effect's `startOffset`, `endOffset`, `startRadius`, and `radius` fields:

```css
.blur-thin-bottom {
  position: relative;
}
.blur-thin-bottom::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  mask-image: linear-gradient(to bottom, transparent, black);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black);
  pointer-events: none;
}
```
