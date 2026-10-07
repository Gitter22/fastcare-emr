// Referential integrity check for the spec. Run: npm run validate
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { loadUi, walkRegions, walkScreen, goTargets, patternChain, TYPES } from "./ui-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = f => yaml.load(fs.readFileSync(path.join(root, "spec", f), "utf8"));
const errors = [];
const err = m => errors.push(m);

const { roles } = load("roles.yaml");
const { modules } = load("modules.yaml");
const { screens } = load("screens.yaml");
const { flows } = load("flows.yaml");
const { machines } = load("states.yaml");
const { invariants } = load("invariants.yaml");
const { gateways } = load("integrations.yaml");
const { slices } = load("slices.yaml");

const uniq = (list, kind) => {
  const seen = new Set();
  for (const x of list) { if (seen.has(x.id)) err(`duplicate ${kind} id: ${x.id}`); seen.add(x.id); }
  return seen;
};
const roleIds = uniq(roles, "role");
const screenIds = uniq(screens, "screen");
uniq(modules, "module");
uniq(flows, "flow");
uniq(machines, "machine");
const machineMap = new Map(machines.map(m => [m.id, m]));
const invIds = uniq(invariants, "invariant");

const checkRoles = (rs, where) => (rs || []).forEach(r => roleIds.has(r) || err(`${where}: unknown role '${r}'`));
const checkInv = (is, where) => (is || []).forEach(i => invIds.has(i) || err(`${where}: unknown invariant '${i}'`));
const checkScreen = (s, where) => screenIds.has(s) || err(`${where}: unknown screen '${s}'`);

// roles
roles.forEach(r => checkScreen(r.home, `role ${r.id}.home`));

// modules <-> screens: each screen in exactly one group
const placed = new Map();
for (const m of modules) for (const g of m.groups) for (const s of g.screens) {
  checkScreen(s, `module ${m.id}/${g.name}`);
  placed.set(s, (placed.get(s) || 0) + 1);
}
for (const s of screens) {
  const n = placed.get(s.id) || 0;
  if (n !== 1) err(`screen ${s.id} appears in ${n} module groups (expected 1)`);
  checkRoles(s.roles, `screen ${s.id}`);
  checkInv(s.invariants, `screen ${s.id}`);
  if (!s.purpose) err(`screen ${s.id}: missing purpose`);
}

// state machines
const transitionKey = new Set();
for (const m of machines) {
  const st = new Set(m.states.map(s => s.id));
  for (const t of m.transitions) {
    const where = `machine ${m.id} ->${t.to}`;
    if (!st.has(t.to)) err(`${where}: unknown state '${t.to}'`);
    for (const f of t.from) { if (!st.has(f)) err(`${where}: unknown from-state '${f}'`); transitionKey.add(`${m.id}:${f}->${t.to}`); }
    checkRoles(t.by, where); checkInv(t.invariants, where);
  }
}

// flows
const stepRefs = new Set();
for (const f of flows) {
  stepRefs.add(`flow:${f.id}`);
  const seen = new Set();
  for (const s of f.steps) {
    const where = `flow:${f.id}/${s.id}`;
    if (seen.has(s.id)) err(`${where}: duplicate step id`); seen.add(s.id);
    stepRefs.add(where);
    checkRoles([s.role], where);
    if (s.screen === null) {
      if (s.role !== "system") err(`${where}: only system steps may have a null screen`);
      if (!s.surface) err(`${where}: system step needs 'surface'`); else checkScreen(s.surface, where);
    } else checkScreen(s.screen, where);
    checkInv(s.invariants, where);
    if (s.transition) {
      const [mid] = s.transition.split(":");
      if (!machineMap.has(mid)) err(`${where}: unknown machine '${mid}'`);
      else if (!transitionKey.has(s.transition)) err(`${where}: transition '${s.transition}' not allowed in states.yaml`);
    }
  }
}

// gateways and slices
for (const g of gateways) (g.used_by || []).forEach(r => stepRefs.has(r) || err(`gateway ${g.id}: unknown step '${r}'`));
for (const sl of slices) {
  (sl.flows || []).forEach(r => stepRefs.has(r) || err(`slice ${sl.id}: unknown flow ref '${r}'`));
  (sl.screens || []).forEach(s => checkScreen(s, `slice ${sl.id}`));
  checkInv(sl.invariants, `slice ${sl.id}`);
}

// invariants doc <-> index
const doc = fs.readFileSync(path.join(root, "docs", "02-invariants.md"), "utf8");
const docIds = new Set(doc.match(/INV-[A-Z]+-\d+/g));
invIds.forEach(i => docIds.has(i) || err(`invariant ${i} missing from docs/02-invariants.md`));
docIds.forEach(i => invIds.has(i) || err(`docs/02-invariants.md mentions ${i}, not in spec/invariants.yaml`));

// ---------- UI spec (spec/ui) ----------
const ui = loadUi(root);
const uiWarn = [];
ui.dupes.forEach(id => err(`ui: screen ${id} defined in more than one ui file`));
for (const id of screenIds) if (!ui.screens[id]) err(`ui: screen ${id} has no entry in spec/ui/*.yaml`);
for (const id of Object.keys(ui.screens)) if (!screenIds.has(id)) err(`ui: ${id} (${ui.fileOf[id]}) is not a screen in spec/screens.yaml`);

const navBlocks = new Set(Object.keys(ui.nav).filter(k => Array.isArray(ui.nav[k]) && k !== "rules"));
const containers = new Set(Object.keys(ui.patterns.containers || {}));
const viewExists = t => { const [s, v] = t.split("#"); return !!ui.screens[s] && (!v || !!(ui.screens[s].views || {})[v]); };
const checkGo = (go, where) => {
  for (const t of goTargets(go)) {
    if (t === "back" || t.startsWith("external:")) continue;
    if (!viewExists(t)) err(`${where}: go target '${t}' does not exist`);
  }
};
const checkEl = (el, where) => {
  if (!el || !el.id) { err(`${where}: element without id`); return; }
  if (!TYPES.has(el.type)) err(`${where}/${el.id}: unknown type '${el.type}'`);
  if (el.be && !["ui", "crud", "logic"].includes(el.be)) err(`${where}/${el.id}: be must be ui, crud or logic`);
  checkGo(el.go, `${where}/${el.id}`);
  (el.opens || []).forEach(t => checkGo(t, `${where}/${el.id} opens`));
  if (el.tr && !transitionKey.has(el.tr)) err(`${where}/${el.id}: transition '${el.tr}' not allowed in states.yaml`);
  checkInv(el.inv, `${where}/${el.id}`);
  if (typeof el.bind === "string" && el.bind.startsWith("states:") && !machineMap.has(el.bind.slice(7))) err(`${where}/${el.id}: unknown state machine in bind '${el.bind}'`);
};
const checkNavRef = (ref, where) => {
  const m = /^nav\.yaml#(.+)$/.exec(ref);
  if (!m || !navBlocks.has(m[1])) err(`${where}: unknown nav reference '${ref}'`);
};

// patterns
for (const [pid, p] of Object.entries(ui.patterns.patterns)) {
  if (p.extends && !ui.patterns.patterns[p.extends]) err(`ui pattern ${pid}: extends unknown '${p.extends}'`);
  for (const item of walkRegions(p.regions, { screen: `pattern:${pid}` })) {
    if (item.kind === "navref") checkNavRef(item.ref, `pattern ${pid}/${item.region}`);
    else if (item.kind === "el") checkEl(item.el, `pattern ${pid}`);
    else err(`pattern ${pid}/${item.region}: region must be a list or nav reference`);
  }
}
// nav blocks
for (const b of navBlocks) for (const el of ui.nav[b]) checkEl(el, `nav ${b}`);
for (const r of Object.values(ui.nav.roots || {}).flat()) if (!ui.screens[r]) err(`nav roots: unknown screen ${r}`);

// screens
const routes = new Map();
for (const [id, s] of Object.entries(ui.screens)) {
  const where = `ui ${id}`;
  if (!ui.patterns.patterns[s.pattern]) err(`${where}: unknown pattern '${s.pattern}'`);
  if (s.route === undefined) err(`${where}: missing route (use null for overlays)`);
  if (s.route === null && !s.container) err(`${where}: overlay (route null) needs a container`);
  if (s.route) { if (routes.has(s.route)) err(`${where}: route ${s.route} also used by ${routes.get(s.route)}`); routes.set(s.route, id); }
  if (s.container && !containers.has(s.container)) err(`${where}: unknown container '${s.container}'`);
  if (s.up === undefined) err(`${where}: missing 'up' (use null for roots)`);
  else if (s.up !== null && !ui.screens[s.up]) err(`${where}: up '${s.up}' is not a screen`);
  (s.flows || []).forEach(r => stepRefs.has(r) || err(`${where}: unknown flow ref '${r}'`));
  for (const [vid, v] of Object.entries(s.views || {})) {
    if (!containers.has(v.container)) err(`${where}#${vid}: unknown container '${v.container}'`);
    (v.flows || []).forEach(r => stepRefs.has(r) || err(`${where}#${vid}: unknown flow ref '${r}'`));
  }
  const reserved = new Set();
  for (const p of patternChain(ui.patterns, s.pattern))
    for (const item of walkRegions(ui.patterns.patterns[p].regions, {})) if (item.kind === "el") reserved.add(item.el.id);
  const ids = new Set();
  for (const item of walkScreen(id, s)) {
    const w = item.view ? `${where}#${item.view}` : where;
    if (item.kind === "navref") { checkNavRef(item.ref, `${w}/${item.region}`); continue; }
    if (item.kind === "bad-region") { err(`${w}/${item.region}: region must be a list or nav reference`); continue; }
    checkEl(item.el, w);
    if (!item.el.id) continue;
    if (ids.has(item.el.id)) err(`${w}: duplicate element id '${item.el.id}'`);
    if (reserved.has(item.el.id) && item.region && !["context-drawer", "action-bar"].includes(item.region)) uiWarn.push(`${w}: element '${item.el.id}' shadows a pattern element`);
    ids.add(item.el.id);
  }
}

// reachability: from roots, nav blocks and pattern elements, follow every go edge
const edges = new Map(); // node -> Set(target nodes); nodes are "screen" or "screen#view"
const addEdge = (from, to) => { if (!edges.has(from)) edges.set(from, new Set()); edges.get(from).add(to); };
const GLOBAL = "@global";
for (const b of navBlocks) for (const el of ui.nav[b]) goTargets(el.go).forEach(t => addEdge(GLOBAL, t));
for (const p of Object.values(ui.patterns.patterns)) for (const item of walkRegions(p.regions, {})) if (item.kind === "el") goTargets(item.el.go).forEach(t => addEdge(GLOBAL, t));
for (const [id, s] of Object.entries(ui.screens)) {
  for (const item of walkScreen(id, s)) if (item.kind === "el") [...goTargets(item.el.go), ...(item.el.opens || [])].forEach(t => addEdge(item.view ? `${id}#${item.view}` : id, t));
  for (const vid of Object.keys(s.views || {})) addEdge(`${id}#${vid}`, id); // closing a view returns to its screen
}
const seen = new Set([GLOBAL, ...Object.values(ui.nav.roots || {}).flat()]);
const queue = [...seen];
while (queue.length) {
  const n = queue.shift();
  const targets = new Set(edges.get(n) || []);
  if (n !== GLOBAL && !n.includes("#")) { const s = ui.screens[n]; if (s && s.up) targets.add(s.up); }
  for (const t of targets) {
    if (t === "back" || t.startsWith("external:")) continue;
    for (const node of [t, t.split("#")[0]]) if (!seen.has(node)) { seen.add(node); queue.push(node); }
  }
}
for (const [id, s] of Object.entries(ui.screens)) {
  if (!seen.has(id)) err(`ui ${id}: unreachable (no navigation path from roots, rail or command bar)`);
  for (const vid of Object.keys(s.views || {})) if (!seen.has(`${id}#${vid}`)) uiWarn.push(`ui ${id}#${vid}: view is never opened by any 'go'`);
}
uiWarn.forEach(w => console.warn("warn:", w));
const uiViewCount = Object.values(ui.screens).reduce((n, s) => n + Object.keys(s.views || {}).length, 0);
let uiElCount = 0; for (const [id, s] of Object.entries(ui.screens)) for (const item of walkScreen(id, s)) if (item.kind === "el") uiElCount++;

// coverage (warnings)
const usedInv = new Set([
  ...screens.flatMap(s => s.invariants || []),
  ...flows.flatMap(f => f.steps.flatMap(s => s.invariants || [])),
  ...slices.flatMap(s => s.invariants || []),
]);
invIds.forEach(i => usedInv.has(i) || console.warn(`warn: invariant ${i} not referenced by any screen, step or slice`));

if (errors.length) { errors.forEach(e => console.error("error:", e)); console.error(`\n${errors.length} error(s)`); process.exit(1); }
const steps = flows.reduce((n, f) => n + f.steps.length, 0);
console.log(`spec ok: ${roles.length} roles, ${modules.length} modules, ${screens.length} screens, ${flows.length} flows (${steps} steps), ${machines.length} state machines, ${invariants.length} invariants; ui: ${Object.keys(ui.screens).length} screens, ${uiViewCount} views, ${uiElCount} elements, all reachable`);
