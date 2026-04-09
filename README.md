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
  primitives.css                 ← converted values (oklch colors, rem sizes, …)
  semantics.css                  ← semantic aliases via var() — inherit from primitives
  mall-of-semantics.css          ← Mall Of brand overrides for semantic tokens
  share-semantics.css            ← Share brand overrides for semantic tokens
  typography.css                 ← typography tokens (font, size, weight…)
  mall-of-typography.css         ← Mall Of brand overrides for typography
  share-typography.css           ← Share brand overrides for typography
  styles.css                     ← utility classes for all Figma text & effect styles
```

`index.css` loads token files in dependency order — primitives first, then semantics, then typography. `styles.css` comes last and references all token variables defined in the other files.

---

## How the script works

### 1. Fetch variables from the Figma API

The script calls:

- `GET /v1/files/{fileKey}/variables/local` — all variables defined in the file
- `GET /v1/files/{fileKey}/styles` — all local text and effect styles
- `GET /v1/files/{fileKey}/nodes?ids=…` — node data for effect styles (to read effect values and variable bindings)

### 2. Handle extended collections

Figma supports **extended collections** — collections that inherit the same variables as a base collection but add brand-specific mode groupings (e.g. "Mall Of" extends "Semantics" to provide brand overrides).

These are identified by the `isExtension: true` flag on the collection. Their modes carry a `parentModeId` field that points to the actual key inside each variable's `valuesByMode` map.

### 3. Build CSS variable names

Variable names follow the Figma path directly, converted to kebab-case:

```
color/base/black    →  --color-base-black
heading/font        →  --heading-font
effects/spread/-2   →  --effects-spread--2   (negative numbers get a double-dash prefix)
effects/spread/2    →  --effects-spread-2
```

No collection name prefix is added.

### 4. Resolve aliases

When a variable's value is a reference to another variable (`VARIABLE_ALIAS`), the script outputs a CSS `var()` reference. Semantics and typography collections are pure `var()` references — all value conversion happens in primitives and cascades through naturally.

### 5. Convert values

All value conversions happen in the **primitives** collection. Semantics and typography inherit converted values through `var()` references.

| Figma type | Variable prefix | CSS output |
|------------|----------------|------------|
| `COLOR` | `color/*` (primitives) | `oklch(L C H)` / `oklch(L C H / A)` / `transparent` |
| `COLOR` | Semantics, typography | `var(--color-*)` — inherits oklch from primitives |
| `FLOAT` | `spacing/`, `border/`, `rounded/` | `Xrem` |
| `FLOAT` | `font/size/`, `font/line-height/`, `font/spacing/` | `Xrem` |
| `FLOAT` | `effects/blur/`, `effects/position/`, `effects/spread/` | `Xrem` |
| `FLOAT` | `font/weight/`, `effects/depth/`, `effects/dispersion/`, etc. | plain number (unitless) |
| `STRING` | Any | `"value"` |
| `BOOLEAN` | Any | `1` or `0` |

#### OKLCH color conversion

Colors in the primitives collection are converted to `oklch()` using the Björn Ottosson Oklab matrices (sRGB → linearise → LMS → Oklab → OKLCH). This enables perceptually-uniform colour manipulation in consuming code. Zero-alpha colors are emitted as `transparent`.

Semantic and typography collections reference these via `var()` — no re-conversion needed.

#### Rem conversion

Numeric pixel values in the primitives collection are divided by 16 to produce `rem` values for spatial tokens (spacing, border radius, font sizes, effect sizes). Unitless values such as font weights, opacity-style effect parameters, and zero values are left as plain numbers.

#### Negative spread token naming

Negative numbers in variable paths produce a double-dash in the CSS custom property name to avoid collisions with positive counterparts:

```css
--effects-spread--2: -0.125rem;   /* effects/spread/-2 */
--effects-spread-2:   0.125rem;   /* effects/spread/2  */
```

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

1. `primitives.css` — converted tokens, no dependencies
2. `semantics.css` — `var()` references to primitives
3. Semantics extensions — brand overrides for semantic tokens
4. `typography.css` — `var()` references to primitives
5. Typography extensions — brand overrides for typography tokens
6. `styles.css` — utility classes, references all of the above

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

CSS utility classes are created for each effect style. All numeric values (blur radius, shadow offsets, spread) and colors reference primitive tokens via `var()`. The script uses Figma's `boundVariables` data on each effect to resolve variable references directly — including semantic color tokens like `color/alpha/dark/10`.

| Figma style name | CSS class |
|------------------|-----------|
| `shadow/raised` | `.shadow-raised` |
| `blur/base` | `.blur-base` |
| `liquid-glass/base` | `.liquid-glass-base` |

Example shadow output:
```css
.shadow-raised {
  box-shadow: var(--effects-position-0) var(--effects-position-4)
              var(--effects-blur-8) var(--effects-spread--2)
              var(--color-alpha-dark-10);
}
```

**Uniform blurs** output a direct `backdrop-filter: blur()` or `filter: blur()` declaration referencing a blur token:

```css
.blur-base {
  backdrop-filter: blur(var(--effects-blur-8));
}
```

**Progressive blurs** (Figma `blurType: "PROGRESSIVE"`) output a `::after` pseudo-element with `backdrop-filter` and a `mask-image` gradient, computed from the effect's `startOffset`, `endOffset`, `startRadius`, and `radius` fields:

```css
.blur-thin-bottom {
  position: relative;
}
.blur-thin-bottom::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(var(--effects-blur-4));
  -webkit-backdrop-filter: blur(var(--effects-blur-4));
  mask-image: linear-gradient(to bottom, transparent, black);
  -webkit-mask-image: linear-gradient(to bottom, transparent, black);
  pointer-events: none;
}
```
