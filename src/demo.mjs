#!/usr/bin/env node
// Generates clearly-labelled sample data so you can see the dashboard before
// wiring up a real game. `npm run demo` then `npm run build`.
// Delete the data/ folder to clear it out.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirs, writeJson, appendTimeseries, readTimeseries, round } from "./lib/store.mjs";
import { buildRecords, dailyVisits, deriveLive, deriveAdEconomics } from "./lib/derive.mjs";
import { parseAdsCsv, summariseAds } from "./lib/ads.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
ensureDirs(ROOT);

// deterministic pseudo random so the demo looks the same every time
let seed = 20260827;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const DAYS = 21;
const STEP = 15 * 60000; // a sample every 15 minutes
const end = Date.now();
const start = end - DAYS * 86400000;

fs.rmSync(path.join(DATA, "timeseries.csv"), { force: true });

let visits = 41200;
let favorites = 610;
let up = 402, down = 96;
let badgeTotal = 28400;

const tsPath = path.join(DATA, "timeseries.csv");
for (let t = start; t <= end; t += STEP) {
  const d = new Date(t);
  const hourUtc = d.getUTCHours();
  const dayIdx = Math.floor((t - start) / 86400000);

  // UK/US evening double peak, weekend lift, slow decay after the launch spike
  const diurnal = 0.42 + 0.58 * Math.max(
    Math.exp(-((hourUtc - 19) ** 2) / 12),
    0.75 * Math.exp(-((hourUtc - 15) ** 2) / 14)
  );
  const weekend = [0, 6].includes(d.getUTCDay()) ? 1.28 : 1;
  const launchDecay = 0.55 + 0.45 * Math.exp(-dayIdx / 9);
  const adBoost = dayIdx >= 6 && dayIdx <= 11 ? 1.55 : 1; // the paid campaign window
  const noise = 0.82 + rnd() * 0.36;

  const ccu = Math.max(0, Math.round(34 * diurnal * weekend * launchDecay * adBoost * noise));
  const joinRate = ccu * (0.55 + rnd() * 0.3);
  visits += Math.round(joinRate);
  if (rnd() < 0.16) favorites += Math.round(1 + rnd() * 2);
  if (rnd() < 0.13) up += 1;
  if (rnd() < 0.035) down += 1;
  badgeTotal += Math.round(joinRate * 0.7);

  const serverCount = Math.max(0, Math.ceil(ccu / 5.4));
  const capacity = serverCount * 6;
  appendTimeseries(tsPath, {
    iso: new Date(t).toISOString(),
    epoch: t,
    ccu,
    visits,
    favorites,
    upVotes: up,
    downVotes: down,
    ratingPct: round((up / (up + down)) * 100, 3),
    servers: serverCount,
    avgServerFill: capacity ? round((ccu / capacity) * 100, 2) : null,
    avgPing: round(52 + rnd() * 34, 1),
    avgFps: round(56 + rnd() * 4, 1),
    badgeAwardsTotal: badgeTotal,
    badgeAwardsPastDay: Math.round(240 * launchDecay * adBoost * (0.8 + rnd() * 0.4)),
  });
}

const rows = readTimeseries(tsPath);
const last = rows[rows.length - 1];

const servers = Array.from({ length: Math.max(1, last.servers) }, (_, i) => {
  const maxPlayers = 6;
  const playing = Math.max(1, Math.min(maxPlayers, Math.round(1 + rnd() * maxPlayers)));
  return { id: `${(1000+i*7919).toString(16)}-${(i*104729%99991).toString(16)}`, playing, maxPlayers,
    fps: round(55 + rnd() * 5, 1), ping: round(40 + rnd() * 80, 1) };
});

const badgeSpec = [
  ["Welcome to the Water Factory", 1.0, 62.4],
  ["Place your first printer", 0.71, 44.1],
  ["Sell 100 bottles", 0.48, 29.8],
  ["First merge", 0.31, 19.2],
  ["Reach floor 2", 0.19, 11.8],
  ["First rebirth", 0.115, 7.1],
  ["Buy a gear boost", 0.082, 5.1],
  ["Reach floor 5", 0.041, 2.5],
  ["Ten rebirths", 0.017, 1.1],
  ["Five star printer", 0.006, 0.4],
];
const entry = 31240;
const badges = badgeSpec.map(([name, share, winRate], i) => ({
  id: 100 + i, name, enabled: true,
  awardedCount: Math.round(entry * share),
  pastDayAwardedCount: Math.round(entry * share * 0.031),
  winRatePercentage: winRate,
}));

const gamePasses = [
  { id: 1, name: "2x Cash", price: 99 },
  { id: 2, name: "Auto Collect", price: 149 },
  { id: 3, name: "VIP Water Lord", price: 399 },
  { id: 4, name: "Instant Rebirth", price: 249 },
];

// A sample export shaped like the Ads Manager download, which also exercises
// the CSV parser end to end.
const adsCsv = [
  "Campaign name,Status,Campaign type,Spent,Impressions,CTR,Clicks,Plays,CPP,Playtime,Start date,End date",
  '"Launch Push - Plays",Completed,Plays,"40.90 USD","388,512","2.99%","11,617","3,164","0.0129 USD","248 hrs",2026-08-06,2026-08-12',
  '"Release Boost",Learning,Plays,"0.01 USD","3","—","—","—","—","—",2026-08-26,',
  '"Weekend Retarget",Completed,Plays,"0.02 USD","89","—","—","1","0.020 USD","—",2026-08-20,2026-08-21',
].join("\n");
fs.writeFileSync(path.join(ROOT, "ads-drop", "SAMPLE-ads-export.csv"), adsCsv);
const campaigns = parseAdsCsv(adsCsv, "SAMPLE-ads-export.csv");
const adSummary = summariseAds(campaigns);

// Open Cloud style daily series
const series = { DailyActiveUsers: [], DailyRevenue: [], ForwardD1Retention: [],
  ForwardD7Retention: [], NewUsers: [], AverageSessionLength: [], MonthlyActiveUsers: [] };
let mau = 0;
for (let i = DAYS; i >= 0; i--) {
  const day = new Date(end - i * 86400000);
  day.setUTCHours(0, 0, 0, 0);
  const iso = day.toISOString();
  const idx = DAYS - i;
  const decay = 0.55 + 0.45 * Math.exp(-idx / 9);
  const ad = idx >= 6 && idx <= 11 ? 1.5 : 1;
  const dau = Math.round(880 * decay * ad * (0.88 + rnd() * 0.24));
  mau += Math.round(dau * 0.42);
  series.DailyActiveUsers.push({ time: iso, value: dau, series: "total" });
  series.MonthlyActiveUsers.push({ time: iso, value: mau, series: "total" });
  series.NewUsers.push({ time: iso, value: Math.round(dau * (0.62 - idx * 0.008)), series: "total" });
  series.DailyRevenue.push({ time: iso, value: Math.round(dau * (0.9 + rnd() * 1.4)), series: "total" });
  series.ForwardD1Retention.push({ time: iso, value: round(0.112 + rnd() * 0.03 + idx * 0.0018, 4), series: "total" });
  series.ForwardD7Retention.push({ time: iso, value: round(0.031 + rnd() * 0.012 + idx * 0.0006, 4), series: "total" });
  series.AverageSessionLength.push({ time: iso, value: round(7.4 + rnd() * 3.2, 2), series: "total" });
}

const analytics = {
  fetchedAt: new Date().toISOString(),
  window: { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() },
  supported: Object.keys(series),
  unsupported: [{ metric: "TotalPlaytime", reason: "sample data only" }],
  series,
};

const snap = { servers, badges, gamePasses };
const records = buildRecords(rows, {});
const daily = dailyVisits(rows);
const live = deriveLive(rows, snap);
const robuxToUsd = 0.0035;

const latest = {
  generatedAt: last.iso,
  demo: true,
  game: {
    universeId: 0, placeId: 0,
    name: "DEMO - sample data, not a real game",
    creator: { name: "Preview", type: "User" },
    created: new Date(start).toISOString(),
    updated: last.iso,
    maxPlayers: 6, genre: "Tycoon", price: null, icon: null,
    url: "https://www.roblox.com/",
  },
  live, records,
  servers: servers.sort((a, b) => b.playing - a.playing).slice(0, 60),
  badges,
  gamePasses,
  ads: { summary: adSummary, economics: deriveAdEconomics(adSummary, live, series, robuxToUsd), campaigns },
  competitors: [
    { name: "Rival tycoon A", universeId: 991, ccu: 1840, visits: 12400000, favorites: 88000, ratingPct: 86.2 },
    { name: "Rival tycoon B", universeId: 992, ccu: 402, visits: 2100000, favorites: 15200, ratingPct: 78.9 },
  ],
  analytics,
  settings: { robuxToUsd, timezone: "Europe/London" },
  health: { errors: {}, runtimeMs: 812 },
};

// competitor history
for (const [uid, base] of [[991, 1840], [992, 402]]) {
  const f = path.join(DATA, "competitors", `${uid}.csv`);
  const lines = ["iso,ccu,visits,favorites,ratingPct"];
  for (let t = start; t <= end; t += STEP * 4) {
    const d = new Date(t);
    const diurnal = 0.5 + 0.5 * Math.exp(-((d.getUTCHours() - 19) ** 2) / 16);
    lines.push(`${new Date(t).toISOString()},${Math.round(base * diurnal * (0.85 + rnd() * 0.3))},,,`);
  }
  fs.writeFileSync(f, lines.join("\n") + "\n");
}

writeJson(path.join(DATA, "latest.json"), latest);
writeJson(path.join(DATA, "records.json"), records);
writeJson(path.join(DATA, "daily.json"), daily);
writeJson(path.join(DATA, "analytics.json"), analytics);
writeJson(path.join(DATA, "history.json"), rows);

console.log(`demo data written: ${rows.length} samples over ${DAYS} days`);
console.log(`peak ccu ${records.peakCcu}, visits ${last.visits.toLocaleString("en-GB")}, ${campaigns.length} ad campaigns parsed`);
