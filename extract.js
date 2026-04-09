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
 */
function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/\//g, '-')            // Figma path separator → dash
    .replace(/[^a-z0-9-]/g, '-')   // anything else → dash
    .replace(/-+/g, '-')            // collapse multiple dashes
    .replace(/^-|-$/g, '');         // trim leading/trailing dashes
}

/**
 * Build the full CSS variable name for a variable given its collection slug.
 * e.g. collection "maf-colors", variable "brand/primary/500"
 * → "--maf-colors-brand-primary-500"
 */
function cssVarName(collectionSlug, variableName) {
  return `--${collectionSlug}-${toSlug(variableName)}`;
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
 * Semantics collection → spatial tokens: size/, border/, radius/
 */
function shouldConvertToRem(variableName, role) {
  const lower = variableName.toLowerCase();
  if (role === 'semantics') {
    return lower.startsWith('size/')
        || lower.startsWith('border/')
        || lower.startsWith('radius/');
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

  // ── Build a modeId → collection name map (for extension suffix resolution) ──
  const modeIdToCollectionName = {};
  for (const col of Object.values(localCollections)) {
    for (const mode of col.modes) {
      if (!col.isExtension) {
        modeIdToCollectionName[mode.modeId] = col.name;
      }
    }
  }

  // ── Build unique file-name slugs per collection ───────────────────────────
  // For extended collections that share a display name, suffix with the base
  // collection name (e.g. "mall-of-semantics", "mall-of-typography").
  // Fall back to a numeric suffix if the base name can't be resolved.
  const slugCount = {};
  const collectionFileSlug = {}; // colId → unique file slug

  for (const [id, col] of Object.entries(localCollections)) {
    const base = toSlug(col.name);
    slugCount[base] = (slugCount[base] ?? 0) + 1;
    collectionFileSlug[id] = base;
  }

  for (const [id, col] of Object.entries(localCollections)) {
    const base = toSlug(col.name);
    if (slugCount[base] > 1 && col.isExtension) {
      // Resolve base collection name via the first mode's parentModeId
      const parentModeId = col.modes[0]?.parentModeId;
      const parentColName = parentModeId ? modeIdToCollectionName[parentModeId] : null;
      collectionFileSlug[id] = parentColName
        ? `${base}-${toSlug(parentColName)}`
        : `${base}-${id.replace(/\W/g, '-')}`;
    }
  }

  // ── Build CSS variable name map (variable id → CSS var name) ─────────────
  // For variables that belong to a base collection, use that collection's slug.
  // Extended collections reference the same variable IDs, so we look up the
  // variable's own collectionId for naming purposes.
  const collectionNameSlug = {}; // colId → slug used in CSS var names
  for (const [id, col] of Object.entries(localCollections)) {
    collectionNameSlug[id] = toSlug(col.name);
  }

  const varCssNameMap = {};
  for (const [id, variable] of Object.entries(allVariables)) {
    varCssNameMap[id] = `--${toSlug(variable.name)}`;
  }

  // ── Ensure output directory exists ───────────────────────────────────────
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const importPaths = [];

  // ── Generate one CSS file per collection ─────────────────────────────────
  for (const [colId, collection] of Object.entries(localCollections)) {
    if (collection.remote) continue; // skip stale external library references
    // Resolve variable list from the collection's variableIds array.
    // This correctly handles extended collections that share variable IDs
    // with a base collection (variable.variableCollectionId won't match here).
    const variables = (collection.variableIds ?? [])
      .map(vid => allVariables[vid])
      .filter(Boolean);

    const role          = collectionRole(collection, modeIdToCollectionName);
    const convertColors = role !== 'primitives'; // OKLCH for all non-primitive colors
    const convertRem    = role === 'semantics'; // rem for spatial tokens in semantics

    // For the primitives collection, pre-sort variables into groups.
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

        let cssValue;

        if (rawValue && typeof rawValue === 'object' && rawValue.type === 'VARIABLE_ALIAS') {
          if (convertColors && variable.resolvedType === 'COLOR') {
            // Resolve alias chain → output OKLCH
            const resolved = resolveAliasChain(rawValue, allVariables);
            const isColor  = resolved && typeof resolved === 'object' && 'r' in resolved;
            if (isColor) {
              cssValue = colorToOklch(resolved);
            } else {
              const t = varCssNameMap[rawValue.id];
              if (!t) console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
              cssValue = t ? `var(${t})` : `/* unresolved alias: ${rawValue.id} */`;
            }
          } else if (convertRem && variable.resolvedType === 'FLOAT' && shouldConvertToRem(variable.name, role)) {
            // Resolve alias chain → output rem
            const resolved = resolveAliasChain(rawValue, allVariables);
            if (typeof resolved === 'number') {
              cssValue = pxToRem(resolved);
            } else {
              const t = varCssNameMap[rawValue.id];
              if (!t) console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
              cssValue = t ? `var(${t})` : `/* unresolved alias: ${rawValue.id} */`;
            }
          } else {
            const targetName = varCssNameMap[rawValue.id];
            cssValue = targetName
              ? `var(${targetName})`
              : `/* unresolved alias: ${rawValue.id} */`;
            if (!targetName) {
              console.warn(`  Warning: unresolved alias ${rawValue.id} for ${variable.name}`);
            }
          }
        } else {
          // Direct value
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
  const fileSlugToColId = Object.fromEntries(
    Object.entries(collectionFileSlug).map(([id, slug]) => [slug, id])
  );

  function baseNameOf(colId) {
    return toSlug(localCollections[colId]?.name ?? '');
  }

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
    // 3. semantics extensions
    ...writtenFiles.filter(f => extendsCollectionNamed(fileSlugToColId[f.replace('.css','')], 'semantics')),
    // 4. typography base
    ...writtenFiles.filter(f => baseNameOf(fileSlugToColId[f.replace('.css','')]) === 'typography'),
    // 5. typography extensions
    ...writtenFiles.filter(f => extendsCollectionNamed(fileSlugToColId[f.replace('.css','')], 'typography')),
    // 6. anything else not yet included
    ...writtenFiles.filter(f => {
      const colId = fileSlugToColId[f.replace('.css','')];
      return !['primitives','semantics','typography'].includes(baseNameOf(colId))
        && !extendsCollectionNamed(colId, 'semantics')
        && !extendsCollectionNamed(colId, 'typography');
    }),
  ];

  const indexContent = ordered.map(p => `@import "./${p}";`).join('\n') + '\n';
  const indexPath    = path.join(OUTPUT_DIR, 'index.css');
  fs.writeFileSync(indexPath, indexContent, 'utf8');
  console.log(`  Wrote: ${indexPath}`);

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
