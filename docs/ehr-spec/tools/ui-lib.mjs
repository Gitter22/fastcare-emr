// Shared loader and walkers for spec/ui/*.yaml. Used by validate.mjs and ui-docs.mjs.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const TYPES = new Set(("heading text link button icon-button menu toggle tab tabs search input select date textarea checkbox radio " +
  "table list card chip status-chip stat stat-filter alert banner meter chart timeline stepper avatar image placeholder editor signature upload").split(" "));

export function loadUi(root) {
  const dir = path.join(root, "spec", "ui");
  const read = f => yaml.load(fs.readFileSync(path.join(dir, f), "utf8"));
  const patterns = read("patterns.yaml");
  const nav = read("nav.yaml");
  const screens = {};
  const fileOf = {};
  const dupes = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".yaml") && !["patterns.yaml", "nav.yaml"].includes(f)).sort()) {
    const doc = read(f) || {};
    for (const [id, s] of Object.entries(doc.screens || {})) {
      if (screens[id]) dupes.push(id);
      screens[id] = s; fileOf[id] = f;
    }
  }
  return { patterns, nav, screens, fileOf, dupes };
}

// Walk elements of a region map. Region values are arrays of elements or "nav.yaml#block" strings.
export function* walkRegions(regions, ctx) {
  for (const [rid, val] of Object.entries(regions || {})) {
    if (typeof val === "string") { yield { kind: "navref", ref: val, region: rid, ...ctx }; continue; }
    if (!Array.isArray(val)) { yield { kind: "bad-region", region: rid, ...ctx }; continue; }
    for (const el of val) yield* walkEl(el, { ...ctx, region: rid });
  }
}
function* walkEl(el, ctx) {
  yield { kind: "el", el, ...ctx };
  for (const c of el.cols || []) yield* walkEl(c, { ...ctx, parent: el.id });
}

export function* walkScreen(id, s) {
  yield* walkRegions(s.regions, { screen: id, view: null });
  for (const [vid, v] of Object.entries(s.views || {})) yield* walkRegions(v.regions, { screen: id, view: vid });
}

// Normalise go into a list of targets.
export function goTargets(go) {
  if (!go) return [];
  if (typeof go === "string") return [go];
  if (go.by_role) return Object.values(go.by_role);
  return ["?invalid"];
}

export function backendOf(el) {
  if (el.be) return el.be;
  if (el.tr) return "logic";
  if (el.bind || el.does) return "crud";
  return "ui";
}

// Pattern chain (pattern + all it extends), nearest first.
export function patternChain(patterns, name) {
  const out = []; let p = name; const seen = new Set();
  while (p && patterns.patterns[p] && !seen.has(p)) { seen.add(p); out.push(p); p = patterns.patterns[p].extends; }
  return out;
}
