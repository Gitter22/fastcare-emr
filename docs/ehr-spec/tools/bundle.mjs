// Bundles spec/*.yaml into dist/spec.json for viewers (e.g. the IA map page) and other tools.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = {};
for (const f of fs.readdirSync(path.join(root, "spec")).filter(f => f.endsWith(".yaml")).sort())
  Object.assign(out, yaml.load(fs.readFileSync(path.join(root, "spec", f), "utf8")));
const { loadUi } = await import("./ui-lib.mjs");
const u = loadUi(root);
out.ui = { patterns: u.patterns, nav: u.nav, screens: u.screens };
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "spec.json"), JSON.stringify(out, null, 2));
console.log("wrote dist/spec.json");
