#!/usr/bin/env node
// Bakes the collected data into a single standalone HTML file you can open with
// a double click, email, or drop on any static host. The site/ version stays
// fetch-based for GitHub Pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readTimeseries } from "./lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

function competitorSeries() {
  const dir = path.join(DATA, "competitors");
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".csv"))) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").slice(1);
    const pts = lines.map((l) => {
      const [iso, ccu] = l.split(",");
      const t = Date.parse(iso);
      const v = Number(ccu);
      return Number.isFinite(t) && Number.isFinite(v) ? { t, v } : null;
    }).filter(Boolean);
    if (pts.length) out[path.basename(f, ".csv")] = thin(pts, 800);
  }
  return out;
}

function thin(rows, max) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
}

const latest = readJson(path.join(DATA, "latest.json"));
if (!latest) {
  console.error("No data/latest.json yet. Run `npm run collect` first.");
  process.exit(2);
}

const history = thin(readTimeseries(path.join(DATA, "timeseries.csv")), 2500);
const daily = readJson(path.join(DATA, "daily.json"), []);

const payload = { latest, history, daily, competitorSeries: competitorSeries() };

const shell = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
const injected = shell.replace(
  "<script>",
  `<script>window.__TRACKER_DATA__=${JSON.stringify(payload).replace(/</g, "\\u003c")};</script>\n<script>`
);

const outDir = path.join(ROOT, "dist");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "dashboard.html");
fs.writeFileSync(out, injected);

// docs/ is what GitHub Pages serves (Settings -> Pages -> branch main, /docs).
// It is the same page, fetching data/ next to it, so it refreshes itself.
const pub = path.join(ROOT, "docs");
fs.mkdirSync(path.join(pub, "data"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "site", "index.html"), path.join(pub, "index.html"));
fs.writeFileSync(path.join(pub, ".nojekyll"), "");
for (const f of ["latest.json", "daily.json", "records.json", "analytics.json"]) {
  const src = path.join(DATA, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pub, "data", f));
}
fs.writeFileSync(path.join(pub, "data", "history.json"), JSON.stringify(history));

console.log(`built ${out} (${(injected.length / 1024).toFixed(0)} KB, ${history.length} samples)`);
console.log(`built ${pub}/ for GitHub Pages`);
