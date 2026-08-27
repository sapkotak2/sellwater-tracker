// Append-only CSV for the high-resolution timeline plus JSON for current state.
// CSV is used on purpose: it diffs cleanly in git, so a GitHub Actions run adds
// one line per poll instead of rewriting a blob.
import fs from "node:fs";
import path from "node:path";

export const TS_COLUMNS = [
  "iso", "epoch", "ccu", "visits", "favorites", "upVotes", "downVotes",
  "ratingPct", "servers", "avgServerFill", "avgPing", "avgFps",
  "badgeAwardsTotal", "badgeAwardsPastDay",
];

export function ensureDirs(root) {
  for (const d of ["data", "data/competitors", "ads-drop"]) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

export function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function appendTimeseries(file, row) {
  const exists = fs.existsSync(file);
  if (!exists) fs.writeFileSync(file, TS_COLUMNS.join(",") + "\n");
  const line = TS_COLUMNS.map((c) => {
    const v = row[c];
    if (v == null || Number.isNaN(v)) return "";
    return typeof v === "number" ? round(v, 4) : String(v).replace(/,/g, " ");
  }).join(",");
  fs.appendFileSync(file, line + "\n");
}

export function readTimeseries(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    const o = {};
    header.forEach((h, i) => {
      const raw = cells[i];
      if (raw === "" || raw == null) { o[h] = null; return; }
      o[h] = h === "iso" ? raw : Number(raw);
    });
    return o;
  }).filter((r) => r.iso);
}

// Keeps the CSV from growing without bound: everything inside `fullDays` stays
// at full resolution, older rows are thinned to one per hour.
export function compactTimeseries(file, fullDays = 14) {
  const rows = readTimeseries(file);
  if (rows.length < 5000) return rows.length;
  const cutoff = Date.now() - fullDays * 86400000;
  const kept = [];
  const seenHours = new Set();
  for (const r of rows) {
    const t = r.epoch || Date.parse(r.iso);
    if (t >= cutoff) { kept.push(r); continue; }
    const hourKey = Math.floor(t / 3600000);
    if (!seenHours.has(hourKey)) { seenHours.add(hourKey); kept.push(r); }
  }
  const out = [TS_COLUMNS.join(",")];
  for (const r of kept) {
    out.push(TS_COLUMNS.map((c) => (r[c] == null ? "" : r[c])).join(","));
  }
  fs.writeFileSync(file, out.join("\n") + "\n");
  return kept.length;
}

export function round(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
