// Roblox Ads Manager has no public API, so the tracker reads the CSV you export
// with the Download button. This parser is deliberately forgiving about column
// names and units because Roblox changes them between dashboard versions.
import fs from "node:fs";
import path from "node:path";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Canonical field -> the header spellings seen in the wild.
const FIELD_MAP = {
  campaign:   ["campaignname", "campaign", "name", "adname", "adsetname"],
  status:     ["status", "campaignstatus", "state"],
  type:       ["campaigntype", "objective", "type"],
  experience: ["experience", "experiencename", "game", "universe"],
  spent:      ["spent", "amountspent", "spend", "cost", "totalspent", "spentusd"],
  budget:     ["budget", "dailybudget", "totalbudget", "lifetimebudget"],
  bid:        ["bid", "bidamount", "maxbid"],
  impressions:["impressions", "impression", "imps"],
  clicks:     ["clicks", "click", "linkclicks"],
  ctr:        ["ctr", "clickthroughrate"],
  plays:      ["plays", "play", "gameplays", "sessions"],
  cpp:        ["cpp", "costperplay", "avgcostperplay"],
  cpc:        ["cpc", "costperclick"],
  cpm:        ["cpm", "costpermilleimpressions", "costper1000impressions"],
  playtime:   ["playtime", "totalplaytime", "playtimehours", "hoursplayed"],
  start:      ["startdate", "start", "begindate", "datestart"],
  end:        ["enddate", "end", "dateend"],
  date:       ["date", "day", "reportingdate"],
};

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "-" || s === "—" || s.toLowerCase() === "n/a") return null;
  // strips currency codes, %, "hrs", thousands separators
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function hoursFrom(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  // "4:30:00" style durations
  if (/^\d+:\d{2}(:\d{2})?$/.test(s.trim())) {
    const [h, m, sec = 0] = s.trim().split(":").map(Number);
    return h + m / 60 + Number(sec) / 3600;
  }
  const n = num(s);
  if (n == null) return null;
  if (s.includes("min")) return n / 60;
  if (s.includes("sec")) return n / 3600;
  if (s.includes("day")) return n * 24;
  return n; // assume hours
}

export function parseAdsCsv(text, sourceFile = "") {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  // Roblox sometimes prefixes the export with a title line; the header is the
  // first row that contains a recognisable column.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const hits = rows[i].filter((h) =>
      Object.values(FIELD_MAP).some((alts) => alts.includes(norm(h)))
    ).length;
    if (hits >= 2) { headerIdx = i; break; }
  }

  const header = rows[headerIdx].map(norm);
  const index = {};
  for (const [canon, alts] of Object.entries(FIELD_MAP)) {
    const at = header.findIndex((h) => alts.includes(h));
    if (at !== -1) index[canon] = at;
  }

  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const pick = (k) => (index[k] != null ? r[index[k]] : undefined);

    const rec = {
      campaign: (pick("campaign") || "").trim() || `row ${i}`,
      status: (pick("status") || "").trim() || null,
      type: (pick("type") || "").trim() || null,
      experience: (pick("experience") || "").trim() || null,
      spent: num(pick("spent")),
      budget: num(pick("budget")),
      bid: num(pick("bid")),
      impressions: num(pick("impressions")),
      clicks: num(pick("clicks")),
      ctr: num(pick("ctr")),
      plays: num(pick("plays")),
      cpp: num(pick("cpp")),
      cpc: num(pick("cpc")),
      cpm: num(pick("cpm")),
      playtimeHours: hoursFrom(pick("playtime")),
      start: (pick("start") || pick("date") || "").trim() || null,
      end: (pick("end") || "").trim() || null,
      sourceFile: path.basename(sourceFile),
      extra: {},
    };

    // Anything we did not map is kept rather than dropped.
    const claimed = new Set(Object.values(index));
    header.forEach((h, ci) => {
      if (!claimed.has(ci) && r[ci] != null && String(r[ci]).trim() !== "")
        rec.extra[rows[headerIdx][ci]] = r[ci];
    });

    // Fill the gaps the export leaves blank.
    if (rec.ctr == null && rec.clicks != null && rec.impressions)
      rec.ctr = (rec.clicks / rec.impressions) * 100;
    if (rec.cpp == null && rec.spent != null && rec.plays)
      rec.cpp = rec.spent / rec.plays;
    if (rec.cpc == null && rec.spent != null && rec.clicks)
      rec.cpc = rec.spent / rec.clicks;
    if (rec.cpm == null && rec.spent != null && rec.impressions)
      rec.cpm = (rec.spent / rec.impressions) * 1000;

    const meaningful =
      rec.spent != null || rec.impressions != null || rec.plays != null;
    if (meaningful) out.push(rec);
  }
  return out;
}

// Reads every CSV in the drop folder and merges them, newest file winning on
// a campaign name collision.
export function loadAdsFolder(dir) {
  if (!fs.existsSync(dir)) return { campaigns: [], files: [] };
  const files = fs
    .readdirSync(dir)
    // README.txt and the demo's SAMPLE export live here too - skip both.
    .filter((f) => /\.(csv|tsv)$/i.test(f) && !/^SAMPLE-/i.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  const byKey = new Map();
  for (const { f } of files) {
    const full = path.join(dir, f);
    let recs = [];
    try {
      recs = parseAdsCsv(fs.readFileSync(full, "utf8"), full);
    } catch (e) {
      recs = [];
    }
    for (const rec of recs) {
      const key = `${rec.campaign}|${rec.start || ""}|${rec.end || ""}`;
      byKey.set(key, rec);
    }
  }
  return { campaigns: [...byKey.values()], files: files.map((x) => x.f) };
}

export function summariseAds(campaigns) {
  const sum = (k) => campaigns.reduce((a, c) => a + (c[k] ?? 0), 0);
  const spent = sum("spent");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const plays = sum("plays");
  const playtimeHours = sum("playtimeHours");
  return {
    campaignCount: campaigns.length,
    activeCount: campaigns.filter((c) => /learn|active|deliver|run/i.test(c.status || "")).length,
    spent,
    impressions,
    clicks,
    plays,
    playtimeHours,
    ctr: impressions ? (clicks / impressions) * 100 : null,
    cpp: plays ? spent / plays : null,
    cpc: clicks ? spent / clicks : null,
    cpm: impressions ? (spent / impressions) * 1000 : null,
    costPerPlaytimeHour: playtimeHours ? spent / playtimeHours : null,
    playsPerImpression: impressions ? (plays / impressions) * 100 : null,
  };
}
