#!/usr/bin/env node
/**
 * Figma Variables → CSS Custom Properties Extractor
 *
 * Usage:
 *   node --env-file=.env extract.js
 *   node --env-file=.env extract.js --file-key=XXXX --output=./output
 */

import fs from 'fs';
import path from 'path';

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_FILE_KEY = 'HHqZsz18PO50YqqvOKaIfi';

// Parse --key=value flags into a plain object.
// A flag without a value (e.g. --dry-run) is stored as boolean true.
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [key, ...rest] = a.slice(2).split('=');
      return [key, rest.join('=') || true];
    })
);

const FILE_KEY = args['file-key'] || DEFAULT_FILE_KEY;
const OUTPUT_DIR = args['output'] || './output';
const TOKEN = process.env.FIGMA_TOKEN;

if (!TOKEN) {
  console.error('Error: FIGMA_TOKEN environment variable is required.');
  console.error('  Usage: FIGMA_TOKEN=fig_xxx node extract.js');
  process.exit(1);
}

// ─── Figma API ────────────────────────────────────────────────────────────────

// Thin wrapper around the Figma REST API.
// Authenticates with the personal access token from the environment.
async function figmaGet(endpoint) {
  const url = `https://api.figma.com/v1${endpoint}`;
  const res = await fetch(url, {
    headers: { 'X-Figma-Token': TOKEN },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma API error ${res.status} for ${url}:\n${text}`);
  }

  return res.json();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a display name to a CSS-safe kebab-case slug.
 * Handles slashes (Figma variable paths), spaces, and special chars.
 *
 * Negative numeric path segments are preserved with a double-dash prefix so
 * they don't collide with their positive counterparts:
 *   effects/spread/-2  →  effects-spread--2   (--effects-spread--2)
 *   effects/spread/2   →  effects-spread-2    (--effects-spread-2)
 */
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')                              // spaces → single dash (before other transforms)
    .replace(/\/(-?\d+)/g, (_, n) =>                  // numeric path segments: /10 → -10, /-10 → --10
      n.startsWith('-') ? `--${n.slice(1)}` : `-${n}`)
    .replace(/\//g, '-')                               // remaining path separators → dash
    .replace(/[^a-z0-9-]/g, '-')                      // anything else → dash
    .replace(/-{3,}/g, '--')                           // collapse 3+ dashes to double (safety net)
    .replace(/^-+|-+$/g, '');                          // trim leading/trailing dashes
}

/**
 * Convert a Figma COLOR value { r, g, b, a } (0–1 range) to a CSS string.
 * Returns hex when fully opaque, rgba() otherwise.
 */
function colorToCss({ r, g, b, a }) {
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  const A = Math.round(a * 1000) / 1000; // 3 decimal places

  if (A === 0) return 'transparent';
  if (A >= 1) {
    return `#${[R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return `rgba(${R}, ${G}, ${B}, ${A})`;
}

/**
 * Format a raw variable value as a CSS value string.
 * Returns null for VARIABLE_ALIAS (handled separately) or missing values.
 */
function formatValue(value, resolvedType) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.type === 'VARIABLE_ALIAS') return null;

  switch (resolvedType) {
    case 'COLOR':  return colorToCss(value);
    case 'FLOAT':  return String(value);
    case 'STRING': return `"${value}"`;
    case 'BOOLEAN': return value ? '1' : '0';
    default: return String(value);
  }
}

/**
 * Returns the CSS selector for a given mode within a collection.
 * - First mode  → :root
 * - Additional → [data-theme="{slug}"]
 */
function modeSelector(modeIndex, modeSlug) {
  return modeIndex === 0 ? ':root' : `[data-theme="${modeSlug}"]`;
}

/**
 * Given a collection and one of its modes, return the key to look up in
 * variable.valuesByMode. For extended collections the mode carries a
 * parentModeId that points to the actual key; otherwise use modeId directly.
 */
function valueKeyForMode(mode) {
  return mode.parentModeId ?? mode.modeId;
}

// ─── Semantic Token Transformations ───────────────────────────────────────────
//
// Semantic colors are output as oklch() rather than hex/rgba because oklch is
// a perceptually-uniform colour space — mixing, darkening, and lightening colours
// in CSS (e.g. with color-mix()) produce predictable, visually-balanced results.
//
// The conversion pipeline: sRGB → linearise → LMS (cube-root) → Oklab → OKLCH.
// Matrices by Björn Ottosson: https://bottosson.github.io/posts/oklab/

/**
 * Linearise a sRGB channel (0–1) to linear light for OKLCH conversion.
 */
function linearize(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a Figma COLOR { r, g, b, a } (all 0–1) to an oklch() CSS string.
 * Uses the Björn Ottosson Oklab matrices.
 */
function colorToOklch({ r, g, b, a }) {
  const rl = linearize(r), gl = linearize(g), bl = linearize(b);

  // Linear RGB → LMS
  const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
  const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
  const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);

  // LMS → Oklab
  const L =  0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const A =  1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const B =  0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  // Oklab → OKLCH
  const C = Math.sqrt(A * A + B * B);
  const H = ((Math.atan2(B, A) * 180 / Math.PI) + 360) % 360;

  const Lf = +(L.toFixed(4));
  const Cf = +(C.toFixed(4));
  const Hf = +(H.toFixed(2));
  const af = Math.round(a * 1000) / 1000;

  if (af === 0) return 'transparent';
  return af >= 1
    ? `oklch(${Lf} ${Cf} ${Hf})`
    : `oklch(${Lf} ${Cf} ${Hf} / ${af})`;
}

/**
 * Follow a VARIABLE_ALIAS chain to its terminal raw value.
 * At each hop uses the first mode value of the target variable
 * (correct for single-mode primitives; a safe default otherwise).
 * Returns the resolved value, or null on failure / circular reference.
 */
function resolveAliasChain(rawValue, allVariables) {
  let current = rawValue;
  const visited = new Set();
  while (current && typeof current === 'object' && current.type === 'VARIABLE_ALIAS') {
    if (visited.has(current.id)) return null; // circular guard
    visited.add(current.id);
    const target = allVariables[current.id];
    if (!target) return null;
    const vals = Object.values(target.valuesByMode ?? {});
    if (!vals.length) return null;
    current = vals[0];
  }
  if (current === null || current === undefined) return null;
  if (typeof current === 'object' && current.type === 'VARIABLE_ALIAS') return null;
  return current;
}

/**
 * Classify a collection by its semantic role.
 * Returns 'primitives' | 'semantics' | 'typography' | 'other'.
 */
function collectionRole(col, modeIdToCollectionName) {
  const baseName = toSlug(col.name);
  if (baseName === 'primitives') return 'primitives';
  if (baseName === 'semantics')  return 'semantics';
  if (baseName === 'typography') return 'typography';
  if (col.isExtension) {
    const parentModeId = col.modes[0]?.parentModeId;
    const parentName   = parentModeId ? modeIdToCollectionName[parentModeId]?.toLowerCase() : null;
    if (parentName === 'semantics')  return 'semantics';
    if (parentName === 'typography') return 'typography';
  }
  return 'other';
}

/**
 * Return true when this FLOAT variable should be emitted as a rem value.
 *
 * Primitives collection → all spatial and typographic px values:
 *   spacing/, border/, rounded/          — layout dimensions
 *   font/size/, font/line-height/        — typographic sizes
 *   font/spacing/                        — letter-spacing
 *
 * font/weight/ and non-spatial effects (depth, dispersion, refraction,
 * frost, light-intensity, light-angle) are intentionally excluded —
 * they are unitless or percentage-like values that must stay unit-free.
 */
function shouldConvertToRem(variableName, role) {
  const lower = variableName.toLowerCase();
  if (role === 'primitives') {
    return lower.startsWith('spacing/')
        || lower.startsWith('border/')
        || lower.startsWith('rounded/')
        || lower.startsWith('font/size/')
        || lower.startsWith('font/line-height/')
        || lower.startsWith('font/spacing/')
        || lower.startsWith('effects/blur/')
        || lower.startsWith('effects/position/')
        || lower.startsWith('effects/spread/');
  }
  return false;
}

/**
 * Convert a raw px number to a rem CSS string.
 * Zero is returned without a unit (universally valid in CSS).
 */
function pxToRem(px) {
  return px === 0 ? '0' : `${+(px / 16).toFixed(4)}rem`;
}

/**
 * Canonical string key for a Figma color object, used to match effect
 * colors back to the corresponding primitive CSS variable.
 */
function colorKey({ r, g, b, a }) {
  return `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.round(a * 1000) / 1000}`;
}

// ─── Style Sheet Generation ───────────────────────────────────────────────────

/**
 * Slugify a Figma style name into a CSS class name.
 * "shadow/raised"          → "shadow-raised"
 * "liquid glass/base"      → "liquid-glass-base"
 * "paragraph/sm/strong"    → "paragraph-sm-strong"
 */
function styleToClassSlug(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert a Figma color { r, g, b, a } (0–1) to a CSS rgba/hex string.
 * Used for effect colors (raw values, not OKLCH).
 */
function effectColor({ r, g, b, a }) {
  const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
  const A = Math.round(a * 1000) / 1000;
  if (A >= 1) return `#${[R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${R}, ${G}, ${B}, ${A})`;
}

/**
 * Convert a single Figma effect to a CSS descriptor object, or null if
 * unsupported / invisible.
 *
 * Uses reverse-lookup maps to replace raw numbers and colours with var()
 * references to the corresponding primitive tokens where available.
 *
 * Returns one of:
 *   { kind: 'uniform',     property, value }
 *   { kind: 'progressive', blurProperty, blurValue, maskGradient }
 */
function figmaEffectToCss(effect, { effectsBlurVarMap = {}, effectsPositionVarMap = {}, primitiveColorVarMap = {}, varCssNameMap = {} } = {}) {
  if (effect.visible === false) return null;

  // Figma effect nodes carry a `boundVariables` map that records which properties
  // are driven by a variable (radius, spread, offsetX, offsetY, color).
  // We read these first so semantic variables (e.g. color/alpha/dark/10) are
  // referenced directly, rather than resolved to a primitive by value matching.
  const boundVar = propName => {
    const bv = effect.boundVariables?.[propName];
    if (!bv || bv.type !== 'VARIABLE_ALIAS') return null;
    const cssName = varCssNameMap[bv.id];
    return cssName ? `var(${cssName})` : null;
  };

  // Resolution order for each value type:
  //   1. Figma bound variable  → var(--token-name)   [most accurate for color/spread/position]
  //   2. Value reverse-lookup  → var(--effects-*-N)  [preferred for blur — bound variable may
  //                                                    point to a wrong-category token in Figma]
  //   3. Raw rem               → 0.5rem              [last resort]
  // For blur radius the value-map takes priority because Figma can accidentally bind a radius
  // to an effects/position token (same numeric value, different semantic category).
  const blurStr   = r       => (effectsBlurVarMap[r] ? `var(${effectsBlurVarMap[r]})` : null) ?? boundVar('radius') ?? pxToRem(r);
  const posXStr   = x       => boundVar('offsetX') ?? ((x >= 0 && effectsPositionVarMap[x]) ? `var(${effectsPositionVarMap[x]})` : pxToRem(x));
  const posYStr   = y       => boundVar('offsetY') ?? ((y >= 0 && effectsPositionVarMap[y]) ? `var(${effectsPositionVarMap[y]})` : pxToRem(y));
  // Spread: bound variable first; value-map skipped (naming collision between
  // positive and negative spread tokens produces the same CSS custom property name).
  const spreadStr = v       => boundVar('spread') ?? pxToRem(v);
  // Color: bound variable first; then primitive reverse-lookup by raw RGBA value.
  const colStr    = c       => {
    const bv = boundVar('color');
    if (bv) return bv;
    const key = colorKey(c);
    return primitiveColorVarMap[key] ? `var(${primitiveColorVarMap[key]})` : effectColor(c);
  };

  // Progressive blur — has directional start/end offsets and two radii
  if (
    (effect.type === 'BACKGROUND_BLUR' || effect.type === 'LAYER_BLUR') &&
    effect.blurType === 'PROGRESSIVE'
  ) {
    const startR  = effect.startRadius ?? 0;
    const endR    = effect.radius ?? 0;
    const maxR    = Math.max(startR, endR);

    // Derive gradient direction from the offset vector
    const dx = (effect.endOffset?.x ?? 0.5) - (effect.startOffset?.x ?? 0.5);
    const dy = (effect.endOffset?.y ?? 1)   - (effect.startOffset?.y ?? 0);
    let gradientDir;
    if (Math.abs(dy) >= Math.abs(dx)) {
      gradientDir = dy > 0 ? 'to bottom' : 'to top';
    } else {
      gradientDir = dx > 0 ? 'to right' : 'to left';
    }

    // The end with more blur → black (opaque mask); the other → transparent
    const startColor = startR >= endR ? 'black' : 'transparent';
    const endColor   = startR >= endR ? 'transparent' : 'black';
    const cssProp    = effect.type === 'BACKGROUND_BLUR' ? 'backdrop-filter' : 'filter';

    return {
      kind: 'progressive',
      blurProperty: cssProp,
      blurValue:    `blur(${blurStr(maxR)})`,
      maskGradient: `linear-gradient(${gradientDir}, ${startColor}, ${endColor})`,
    };
  }

  switch (effect.type) {
    case 'DROP_SHADOW':
    case 'INNER_SHADOW': {
      const x      = effect.offset?.x ?? 0;
      const y      = effect.offset?.y ?? 0;
      const blur   = effect.radius ?? 0;
      const spread = effect.spread ?? 0;
      const inset  = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
      return {
        kind: 'uniform',
        property: 'box-shadow',
        value: `${inset}${posXStr(x)} ${posYStr(y)} ${blurStr(blur)} ${spreadStr(spread)} ${colStr(effect.color)}`,
      };
    }
    case 'LAYER_BLUR':
      return { kind: 'uniform', property: 'filter',          value: `blur(${blurStr(effect.radius)})` };
    case 'BACKGROUND_BLUR':
      return { kind: 'uniform', property: 'backdrop-filter', value: `blur(${blurStr(effect.radius)})` };
    default:
      return null;
  }
}

/**
 * Fetch local Figma styles and write style.css — utility classes for
 * all text and effect styles, linked to design token CSS variables.
 *
 * Text class naming:
 *   paragraph/xxs           → .paragraph-xxs
 *   paragraph/sm/strong     → .paragraph-sm-strong
 *   subhead/mobile/sm       → .subhead-sm   (uses --subhead-mobile-sm-* vars)
 *   heading/mobile/sm  }
 *   heading/desktop/sm }    → .heading-sm   (mobile-first, @media ≥768px for desktop)
 *
 * Effect class naming:
 *   shadow/raised           → .shadow-raised
 *   blur/thin-bottom        → .blur-thin-bottom
 *   liquid glass/base       → .liquid-glass-base
 */
async function generateStyleSheet(fileKey, outputDir, { effectsBlurVarMap, effectsPositionVarMap, primitiveColorVarMap, varCssNameMap }) {
  const stylesData = await figmaGet(`/files/${fileKey}/styles`);
  const styles     = stylesData.meta?.styles ?? [];

  const textStyles   = styles.filter(s => s.style_type === 'TEXT');
  const effectStyles = styles.filter(s => s.style_type === 'EFFECT');
  console.log(`  Styles      : ${styles.length} (text: ${textStyles.length}, effect: ${effectStyles.length})`);

  // Fetch node data for effect styles to get actual effect values
  let effectNodes = {};
  if (effectStyles.length > 0) {
    const ids       = effectStyles.map(s => s.node_id).join(',');
    const nodesData = await figmaGet(`/files/${fileKey}/nodes?ids=${ids}`);
    effectNodes = nodesData.nodes ?? {};
  }

  // Canonical size order used to sort variant names consistently.
  const VARIANT_ORDER = ['xxs', 'xs', 'sm', 'md', 'lg', 'xl'];
  const sortVariants  = arr =>
    [...arr].sort((a, b) => {
      const ai = VARIANT_ORDER.indexOf(a), bi = VARIANT_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  const lines = [];

  // ── Bucket text styles by category ─────────────────────────────────────────
  //
  // We read each style's name path (e.g. "heading/mobile/sm") and split it into:
  //   category = "heading", platform = "mobile", variant = "sm"
  //
  // Heading styles from mobile and desktop platforms are merged into a single
  // responsive class (.heading-sm) — mobile values as the default, desktop
  // values wrapped in a @media (min-width: 768px) block.
  const paragraphEntries = [];
  const subheadVariants  = new Set();
  const headingMobile    = new Set();
  const headingDesktop   = new Set();

  for (const style of textStyles) {
    const parts    = style.name.split('/').map(p => p.trim().toLowerCase().replace(/\s+/g, '-'));
    const category = parts[0];

    if (category === 'paragraph') {
      paragraphEntries.push(parts);
    } else if (category === 'subhead') {
      // subhead/mobile/sm → variant = sm (we always use the mobile token vars)
      if (parts[2]) subheadVariants.add(parts[2]);
    } else if (category === 'heading') {
      const platform = parts[1]; // 'desktop' | 'mobile'
      const variant  = parts[2];
      if (variant) {
        if (platform === 'mobile')  headingMobile.add(variant);
        if (platform === 'desktop') headingDesktop.add(variant);
      }
    }
  }

  // ── Paragraph ──────────────────────────────────────────────────────────────
  if (paragraphEntries.length > 0) {
    lines.push('');
    lines.push('/* ── Paragraph ─────────────────────────────────────────────────── */');

    // Sort: xxs xs sm sm-strong md md-strong (strong variants follow their base)
    const isStrongParts = parts => {
      const last = parts[parts.length - 1];
      return last === 'strong' || last.endsWith('-strong');
    };
    const baseSlugOf = parts => {
      const last = parts[parts.length - 1];
      if (last === 'strong') return parts.slice(1, -1).join('-');
      if (last.endsWith('-strong')) return last.replace(/-strong$/, '');
      return parts.slice(1).join('-');
    };

    // Sort: xxs → xs → sm → sm-strong → md → md-strong → …
    // Base sizes are ordered by VARIANT_ORDER; strong variants immediately follow.
    const sorted = paragraphEntries.sort((a, b) => {
      const oi = VARIANT_ORDER.indexOf(baseSlugOf(a)), oj = VARIANT_ORDER.indexOf(baseSlugOf(b));
      const order = (oi === -1 ? 99 : oi) - (oj === -1 ? 99 : oj);
      if (order !== 0) return order;
      return isStrongParts(a) ? 1 : -1; // strong after base
    });

    for (const parts of sorted) {
      // Figma encodes strong variants inconsistently:
      //   "paragraph/sm/strong"  → parts = ['paragraph', 'sm', 'strong']
      //   "paragraph/sm-strong"  → parts = ['paragraph', 'sm-strong']
      // We normalise both into baseSlug="sm", isStrong=true.
      const lastPart  = parts[parts.length - 1];
      const isStrong  = lastPart === 'strong' || lastPart.endsWith('-strong');
      // Strip the "-strong" suffix to get the base size name (e.g. "sm")
      const baseSlug  = isStrong
        ? (lastPart === 'strong'
            ? parts.slice(1, -1).join('-')          // ['paragraph','sm','strong'] → 'sm'
            : lastPart.replace(/-strong$/, ''))      // ['paragraph','sm-strong']  → 'sm'
        : parts.slice(1).join('-');
      const className = isStrong ? `${baseSlug}-strong` : baseSlug;
      const varPfx    = `--paragraph-${baseSlug}`;

      lines.push('');
      lines.push(`.paragraph-${className} {`);
      lines.push(`  font-family: var(--paragraph-font);`);
      lines.push(`  font-size: var(${varPfx}-size);`);
      lines.push(`  line-height: var(${varPfx}-line-height);`);
      lines.push(`  font-weight: var(${varPfx}-weight${isStrong ? '-strong' : ''});`);
      lines.push(`  letter-spacing: var(${varPfx}-spacing);`);
      lines.push(`}`);
    }
  }

  // ── Subhead ────────────────────────────────────────────────────────────────
  if (subheadVariants.size > 0) {
    lines.push('');
    lines.push('/* ── Subhead ────────────────────────────────────────────────────── */');

    for (const variant of sortVariants(subheadVariants)) {
      const varPfx = `--subhead-mobile-${variant}`;
      lines.push('');
      lines.push(`.subhead-${variant} {`);
      lines.push(`  font-family: var(--subhead-font);`);
      lines.push(`  font-size: var(${varPfx}-size);`);
      lines.push(`  line-height: var(${varPfx}-line-height);`);
      lines.push(`  font-weight: var(${varPfx}-weight);`);
      lines.push(`  letter-spacing: var(${varPfx}-spacing);`);
      lines.push(`}`);
    }
  }

  // ── Heading (responsive) ───────────────────────────────────────────────────
  const allHeadingVariants = sortVariants(new Set([...headingMobile, ...headingDesktop]));

  if (allHeadingVariants.length > 0) {
    lines.push('');
    lines.push('/* ── Heading ────────────────────────────────────────────────────── */');

    for (const variant of allHeadingVariants) {
      const mob  = `--heading-mobile-${variant}`;
      const desk = `--heading-desktop-${variant}`;
      const hasMob  = headingMobile.has(variant);
      const hasDesk = headingDesktop.has(variant);

      // Base rule — mobile values (or desktop if no mobile variant exists)
      const base = hasMob ? mob : desk;
      lines.push('');
      lines.push(`.heading-${variant} {`);
      lines.push(`  font-family: var(--heading-font);`);
      lines.push(`  font-size: var(${base}-size);`);
      lines.push(`  line-height: var(${base}-line-height);`);
      lines.push(`  font-weight: var(${base}-weight);`);
      lines.push(`  letter-spacing: var(${base}-spacing);`);
      lines.push(`}`);

      // Desktop override via media query
      if (hasMob && hasDesk) {
        lines.push('');
        lines.push(`@media (min-width: 768px) {`);
        lines.push(`  .heading-${variant} {`);
        lines.push(`    font-size: var(${desk}-size);`);
        lines.push(`    line-height: var(${desk}-line-height);`);
        lines.push(`    font-weight: var(${desk}-weight);`);
        lines.push(`    letter-spacing: var(${desk}-spacing);`);
        lines.push(`  }`);
        lines.push(`}`);
      }
    }
  }

  // ── Effect styles ──────────────────────────────────────────────────────────

  // Group by first path segment (shadow, blur, liquid-glass, …)
  const effectGroups = new Map();
  for (const style of effectStyles) {
    const category = styleToClassSlug(style.name.split('/')[0]);
    if (!effectGroups.has(category)) effectGroups.set(category, []);
    effectGroups.get(category).push(style);
  }

  for (const [category, groupStyles] of effectGroups) {
    const title = category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push('');
    lines.push(`/* ── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))} */`);

    for (const style of groupStyles) {
      const className = styleToClassSlug(style.name);
      const node      = effectNodes[style.node_id]?.document;
      const decls     = (node?.effects ?? []).map(e => figmaEffectToCss(e, { effectsBlurVarMap, effectsPositionVarMap, primitiveColorVarMap, varCssNameMap })).filter(Boolean);

      if (decls.length === 0) continue;

      const progressive = decls.find(d => d.kind === 'progressive');
      const uniforms    = decls.filter(d => d.kind === 'uniform');

      if (progressive) {
        // Progressive blur → pseudo-element with mask-image gradient
        lines.push('');
        lines.push(`.${className} {`);
        lines.push(`  position: relative;`);
        lines.push(`}`);
        lines.push('');
        lines.push(`.${className}::after {`);
        lines.push(`  content: '';`);
        lines.push(`  position: absolute;`);
        lines.push(`  inset: 0;`);
        lines.push(`  ${progressive.blurProperty}: ${progressive.blurValue};`);
        lines.push(`  -webkit-${progressive.blurProperty}: ${progressive.blurValue};`);
        lines.push(`  mask-image: ${progressive.maskGradient};`);
        lines.push(`  -webkit-mask-image: ${progressive.maskGradient};`);
        lines.push(`  pointer-events: none;`);
        lines.push(`}`);
      } else {
        // Uniform effect(s) — combine same-property values (multiple shadows, etc.)
        const byProp = new Map();
        for (const { property, value } of uniforms) {
          if (!byProp.has(property)) byProp.set(property, []);
          byProp.get(property).push(value);
        }

        lines.push('');
        lines.push(`.${className} {`);
        for (const [prop, values] of byProp) {
          const indent = ' '.repeat(prop.length + 4);
          lines.push(`  ${prop}: ${values.join(`,\n${indent}`)};`);
        }
        lines.push(`}`);
      }
    }
  }

  lines.push('');
  const outPath = path.join(outputDir, 'styles.css');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`  Wrote: ${outPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching variables from Figma file: ${FILE_KEY}`);

  const localData = await figmaGet(`/files/${FILE_KEY}/variables/local`);

  const localCollections = localData.meta?.variableCollections ?? {};
  const localVariables   = localData.meta?.variables ?? {};
  const allVariables     = localVariables;

  const totalCollections = Object.keys(localCollections).length;
  const totalVariables   = Object.keys(localVariables).length;
  console.log(`  Collections : ${totalCollections}`);
  console.log(`  Variables   : ${totalVariables}`);

  // ── Build a modeId → collection name map ─────────────────────────────────
  //
  // Extended collections don't carry their own variable data — instead each of
  // their modes has a parentModeId that points to a mode in the base collection.
  // This map lets us look up the base collection's name from that parentModeId,
  // which we use to:
  //   a) classify the extension's role (semantics vs. typography)
  //   b) generate a unique file name (e.g. "mall-of-semantics")
  const modeIdToCollectionName = {};
  for (const col of Object.values(localCollections)) {
    for (const mode of col.modes) {
      if (!col.isExtension) {
        // Only index non-extension collections; extension modes are the consumers.
        modeIdToCollectionName[mode.modeId] = col.name;
      }
    }
  }

  // ── Build unique file-name slugs per collection ───────────────────────────
  //
  // In the Figma file, brand extension collections share a display name with
  // their base collection (e.g. both "Mall Of" and the base are called "Semantics"
  // from different perspectives). We need a unique file name per collection to
  // avoid overwriting output files.
  //
  // Strategy: if multiple collections share a slug, rename each extended one by
  // appending the base collection name it extends (e.g. "mall-of-semantics",
  // "share-typography"). Falls back to the raw collection ID as a suffix.
  const slugCount = {};
  const collectionFileSlug = {}; // colId → unique file slug

  // First pass: count how many collections produce each slug.
  for (const [id, col] of Object.entries(localCollections)) {
    const base = toSlug(col.name);
    slugCount[base] = (slugCount[base] ?? 0) + 1;
    collectionFileSlug[id] = base;
  }

  // Second pass: disambiguate slug collisions for extension collections.
  for (const [id, col] of Object.entries(localCollections)) {
    const base = toSlug(col.name);
    if (slugCount[base] > 1 && col.isExtension) {
      // Resolve base collection name via the first mode's parentModeId
      const parentModeId  = col.modes[0]?.parentModeId;
      const parentColName = parentModeId ? modeIdToCollectionName[parentModeId] : null;
      collectionFileSlug[id] = parentColName
        ? `${base}-${toSlug(parentColName)}`
        : `${base}-${id.replace(/\W/g, '-')}`;
    }
  }

  // ── Build CSS variable name map (variable id → CSS var name) ─────────────
  //
  // Maps every variable ID to its CSS custom property name.
  // The name is derived solely from the variable's own path (e.g. "color/base/black"
  // → "--color-base-black") — no collection prefix is added.
  // This map is used both when emitting a variable's own declaration and when
  // resolving a VARIABLE_ALIAS reference to a var() string.
  const collectionNameSlug = {}; // colId → slug used in CSS var names
  for (const [id, col] of Object.entries(localCollections)) {
    collectionNameSlug[id] = toSlug(col.name);
  }

  const varCssNameMap = {};
  for (const [id, variable] of Object.entries(allVariables)) {
    varCssNameMap[id] = `--${toSlug(variable.name)}`;
  }

  // ── Build reverse-lookup maps for generateStyleSheet ─────────────────────
  //
  // These maps let the style generator replace raw pixel values and colours in
  // effect CSS with var() references to the primitive tokens.
  //
  // effectsBlurVarMap    : blur radius px value  → CSS var name
  // effectsPositionVarMap: shadow offset px value → CSS var name (≥ 0 only)
  // primitiveColorVarMap : {r,g,b,a} color key   → CSS var name
  const effectsBlurVarMap     = {};
  const effectsPositionVarMap = {};
  const primitiveColorVarMap  = {};

  for (const [id, variable] of Object.entries(allVariables)) {
    const col = localCollections[variable.variableCollectionId];
    if (!col || col.remote) continue;
    if (collectionRole(col, modeIdToCollectionName) !== 'primitives') continue;

    // Use first mode value (primitives are single-mode)
    const rawValue = Object.values(variable.valuesByMode ?? {})[0];
    const cssName  = varCssNameMap[id];
    const lower    = variable.name.toLowerCase();

    if (variable.resolvedType === 'COLOR' && rawValue && typeof rawValue === 'object' && 'r' in rawValue) {
      primitiveColorVarMap[colorKey(rawValue)] = cssName;
    } else if (variable.resolvedType === 'FLOAT' && typeof rawValue === 'number') {
      if (lower.startsWith('effects/blur/'))     effectsBlurVarMap[rawValue]     = cssName;
      if (lower.startsWith('effects/position/')) effectsPositionVarMap[rawValue] = cssName;
      // effects/spread/ tokens have a naming collision (positive and negative share
      // the same CSS name), so they are excluded and kept as raw px in styles.css.
    }
  }

  // ── Ensure output directory exists ───────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const importPaths = [];

  // ── Generate one CSS file per collection ─────────────────────────────────
  //
  // Each Figma variable collection becomes one CSS file.
  // Collections with multiple modes produce multiple CSS rule blocks:
  //   mode 0 → :root { }         (default / English / Light)
  //   mode N → [data-theme="…"] { }  (Arabic, Dark, brand variants, …)
  for (const [colId, collection] of Object.entries(localCollections)) {
    if (collection.remote) continue; // skip stale external library references

    // Use the collection's own variableIds list to get variables.
    // Extended collections share variable IDs with a base collection, so
    // filtering by variable.variableCollectionId would miss them.
    const variables = (collection.variableIds ?? [])
      .map(vid => allVariables[vid])
      .filter(Boolean);

    const role          = collectionRole(collection, modeIdToCollectionName);
    const convertColors = role === 'primitives'; // OKLCH in primitives; semantics/typography inherit via var()
    const convertRem    = role === 'primitives'; // rem in primitives; semantics/typography inherit via var()

    // Primitives grouping: COLOR → FONT → SPACING → BORDER → ROUNDED → EFFECTS.
    // Variables outside these groups fall into 'other' and appear at the end.
    const PRIMITIVE_GROUP_ORDER = ['color', 'font', 'spacing', 'border', 'rounded', 'effects'];
    const primitiveGroup = varName => {
      const first = varName.toLowerCase().split('/')[0];
      return PRIMITIVE_GROUP_ORDER.includes(first) ? first : 'other';
    };

    const lines = [];

    for (let modeIndex = 0; modeIndex < collection.modes.length; modeIndex++) {
      const mode = collection.modes[modeIndex];
      const modeSlug = toSlug(mode.name);
      const selector = modeSelector(modeIndex, modeSlug);

      // The key into valuesByMode — for extended collections use parentModeId
      const valueKey = valueKeyForMode(mode);

      lines.push(`/* ${collection.name} — ${mode.name} */`);
      lines.push(`${selector} {`);

      let orderedVariables = variables.filter(v => !v.name.startsWith('_'));

      if (role === 'primitives') {
        const buckets = Object.fromEntries(
          [...PRIMITIVE_GROUP_ORDER, 'other'].map(g => [g, []])
        );
        for (const v of orderedVariables) buckets[primitiveGroup(v.name)].push(v);
        orderedVariables = [
          ...PRIMITIVE_GROUP_ORDER.flatMap(g => buckets[g]),
          ...buckets['other'],
        ];
      }

      let lastGroup = '';
      for (const variable of orderedVariables) {
        // Emit a section banner when the group changes (primitives only)
        if (role === 'primitives') {
          const group = primitiveGroup(variable.name);
          if (group !== lastGroup && group !== 'other') {
            lines.push('');
            lines.push(`  /* ── ${group.toUpperCase()} ${'─'.repeat(Math.max(0, 52 - group.length))} */`);
          }
          lastGroup = group;
        }

        const rawValue = variable.valuesByMode?.[valueKey];
        const cssName  = varCssNameMap[variable.id];

        // Determine the CSS output value.
        //
        // There are two kinds of raw values:
        //   1. VARIABLE_ALIAS — a reference to another variable (Figma's alias system).
        //      For most tokens we emit a CSS var() reference so the cascade works.
        //      For OKLCH colors and rem spatial tokens we resolve the full alias chain
        //      to the underlying primitive so we can convert the raw number/colour.
        //   2. Direct value — a literal COLOR, FLOAT, STRING, or BOOLEAN.
        //      These are formatted directly; OKLCH/rem conversions still apply.
        let cssValue;

        if (rawValue && typeof rawValue === 'object' && rawValue.type === 'VARIABLE_ALIAS') {
          if (convertColors && variable.resolvedType === 'COLOR') {
            // Resolve alias chain to its terminal { r, g, b, a } value and
            // convert to oklch() for perceptually-uniform colour manipulation.
            const resolved = resolveAliasChain(rawValue, allVariables);
            const isColor  = resolved && typeof resolved === 'object' && 'r' in resolved;
            if (isColor) {
              cssValue = colorToOklch(resolved);
            } else {
              // Alias target not found in this file — fall back to a var() reference.
              const t = varCssNameMap[rawValue.id];
              if (!t) console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
              cssValue = t ? `var(${t})` : `/* unresolved alias: ${rawValue.id} */`;
            }
          } else if (convertRem && variable.resolvedType === 'FLOAT' && shouldConvertToRem(variable.name, role)) {
            // Resolve alias chain to its terminal px number and convert to rem.
            const resolved = resolveAliasChain(rawValue, allVariables);
            if (typeof resolved === 'number') {
              cssValue = pxToRem(resolved);
            } else {
              // Can't resolve to a number — emit a var() reference instead.
              const t = varCssNameMap[rawValue.id];
              if (!t) console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
              cssValue = t ? `var(${t})` : `/* unresolved alias: ${rawValue.id} */`;
            }
          } else {
            // Standard alias — emit a CSS var() so the token cascade is preserved.
            const targetName = varCssNameMap[rawValue.id];
            cssValue = targetName
              ? `var(${targetName})`
              : `/* unresolved alias: ${rawValue.id} */`;
            if (!targetName) {
              console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
            }
          }
        } else {
          // Direct (non-alias) value — apply the same conversion rules as above.
          if (convertColors && variable.resolvedType === 'COLOR' && rawValue && typeof rawValue === 'object' && 'r' in rawValue) {
            cssValue = colorToOklch(rawValue);
          } else if (convertRem && variable.resolvedType === 'FLOAT' && shouldConvertToRem(variable.name, role) && typeof rawValue === 'number') {
            cssValue = pxToRem(rawValue);
          } else {
            cssValue = formatValue(rawValue, variable.resolvedType) ?? `/* no value */`;
          }
        }

        lines.push(`  ${cssName}: ${cssValue};`);
      }

      lines.push(`}`);
      lines.push('');
    }

    const fileName = `${collectionFileSlug[colId]}.css`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    importPaths.push(fileName);
    const ext = collection.isExtension ? ' [extension]' : '';
    console.log(`  Wrote: ${filePath}  (${variables.length} variables, ${collection.modes.length} modes)${ext}`);
  }

  // ── Write index.css (ordered: primitives → semantics → semantics extensions → typography → typography extensions) ──
  //
  // The import order matters for the CSS cascade:
  //   1. primitives.css  — raw tokens (no dependencies)
  //   2. semantics.css   — references primitives
  //   3. brand-semantics — brand overrides, reference the same primitive vars
  //   4. typography.css  — references primitives
  //   5. brand-typography— brand overrides for typography
  //   6. styles.css      — utility classes, references all token vars above
  const fileSlugToColId = Object.fromEntries(
    Object.entries(collectionFileSlug).map(([id, slug]) => [slug, id])
  );

  // Helper: resolve the canonical (base) slug for a collection ID.
  function baseNameOf(colId) {
    return toSlug(localCollections[colId]?.name ?? '');
  }

  // Helper: return true when a collection extends another collection by name.
  function extendsCollectionNamed(colId, name) {
    const col = localCollections[colId];
    if (!col?.isExtension) return false;
    const parentModeId = col.modes[0]?.parentModeId;
    return parentModeId ? modeIdToCollectionName[parentModeId]?.toLowerCase() === name.toLowerCase() : false;
  }

  const writtenFiles = [...new Set(importPaths)];
  const ordered = [
    // 1. primitives
    ...writtenFiles.filter(f => baseNameOf(fileSlugToColId[f.replace('.css','')]) === 'primitives'),
    // 2. semantics base
    ...writtenFiles.filter(f => baseNameOf(fileSlugToColId[f.replace('.css','')]) === 'semantics'),
    // 3. semantics extensions (brand overrides)
    ...writtenFiles.filter(f => extendsCollectionNamed(fileSlugToColId[f.replace('.css','')], 'semantics')),
    // 4. typography base
    ...writtenFiles.filter(f => baseNameOf(fileSlugToColId[f.replace('.css','')]) === 'typography'),
    // 5. typography extensions (brand overrides)
    ...writtenFiles.filter(f => extendsCollectionNamed(fileSlugToColId[f.replace('.css','')], 'typography')),
    // 6. anything else not yet included
    ...writtenFiles.filter(f => {
      const colId = fileSlugToColId[f.replace('.css','')];
      return !['primitives','semantics','typography'].includes(baseNameOf(colId))
        && !extendsCollectionNamed(colId, 'semantics')
        && !extendsCollectionNamed(colId, 'typography');
    }),
  ];

  const indexContent = [...ordered, 'styles.css'].map(p => `@import "./${p}";`).join('\n') + '\n';
  const indexPath    = path.join(OUTPUT_DIR, 'index.css');
  fs.writeFileSync(indexPath, indexContent, 'utf8');
  console.log(`  Wrote: ${indexPath}`);

  // ── Generate style.css (text + effect style classes) ─────────────────────
  await generateStyleSheet(FILE_KEY, OUTPUT_DIR, { effectsBlurVarMap, effectsPositionVarMap, primitiveColorVarMap, varCssNameMap });

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
