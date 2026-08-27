#!/usr/bin/env node
// Endpoint self-test. Run this first on any new machine - it tells you exactly
// which data source works, which is blocked, and what is missing from setup.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { request } from "./lib/http.mjs";
import { Roblox } from "./lib/roblox.mjs";
import { OpenCloud } from "./lib/opencloud.mjs";
import { loadAdsFolder, summariseAds } from "./lib/ads.mjs";
import { readJson } from "./lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = readJson(path.join(ROOT, "config.json"));

const GREEN = "\x1b[32m", RED = "\x1b[31m", YEL = "\x1b[33m", DIM = "\x1b[2m", OFF = "\x1b[0m";
const results = [];

function log(ok, label, detail) {
  const tag = ok === true ? `${GREEN}pass${OFF}` : ok === "warn" ? `${YEL}warn${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  [${tag}] ${label.padEnd(34)} ${DIM}${detail ?? ""}${OFF}`);
  results.push({ ok, label, detail });
}

async function main() {
  console.log("\nRoblox tracker doctor\n" + "=".repeat(60));

  // 1. config
  let placeId = cfg?.game?.placeId;
  if (!placeId && cfg?.game?.placeUrl) {
    const m = String(cfg.game.placeUrl).match(/\/games\/(\d+)/);
    if (m) placeId = Number(m[1]);
  }
  if (process.env.ROBLOX_PLACE_ID) placeId = Number(process.env.ROBLOX_PLACE_ID);

  console.log("\nConfiguration");
  if (placeId) log(true, "place id", String(placeId));
  else {
    log(false, "place id", "set game.placeUrl in config.json to your roblox.com/games/... link");
    console.log("\nNothing else can be tested without it. Stopping here.\n");
    process.exit(2);
  }

  console.log("\nNetwork and public endpoints");
  const rbx = new Roblox({ timeoutMs: 15000, retries: 1, proxyHost: cfg.collect.proxyHost });

  let universeId = null;
  try {
    universeId = await rbx.universeIdFromPlace(placeId);
    log(Boolean(universeId), "universe id lookup", universeId ? `universe ${universeId}` : "returned nothing");
  } catch (e) {
    log(false, "universe id lookup", e.message);
    console.log(
      `\n  'fetch failed', a timeout, or a 403 from a host you did not expect all mean\n` +
      `  the same thing: this network cannot reach Roblox directly.\n` +
      `  Set  "proxyHost": "roproxy.com"  inside "collect" in config.json and rerun.\n` +
      `  A genuine 400 or 404 here instead means the place id is wrong.\n`
    );
    process.exit(1);
  }
  if (!universeId) process.exit(1);

  const checks = [
    ["game details", async () => {
      const d = await rbx.gameDetails(universeId);
      return d ? `${d.name} - ${d.playing} playing, ${Number(d.visits).toLocaleString("en-GB")} visits` : null;
    }],
    ["votes", async () => {
      const v = await rbx.votes(universeId);
      const total = (v.upVotes ?? 0) + (v.downVotes ?? 0);
      return `${v.upVotes} up / ${v.downVotes} down` + (total ? ` (${((v.upVotes / total) * 100).toFixed(1)}%)` : "");
    }],
    ["favourites count", async () => `${await rbx.favoritesCount(universeId)}`],
    ["public server list", async () => {
      const s = await rbx.publicServers(universeId, 1);
      return `${s.length} servers, ${s.reduce((a, x) => a + x.playing, 0)} players seated`;
    }],
    ["badges", async () => {
      const b = await rbx.badges(universeId, 1);
      return `${b.length} badges, ${b.reduce((a, x) => a + x.awardedCount, 0)} total awards`;
    }],
    ["game passes", async () => {
      const g = await rbx.gamePasses(universeId, placeId);
      if (!g.length) return "none found - Roblox has retired the public endpoint, this is expected";
      return `${g.length} passes (${g.map((x) => x.price ?? "?").join(", ")} R$)`;
    }],
    ["icon thumbnail", async () => (await rbx.icon(universeId)) ? "resolved" : "none"],
  ];

  for (const [label, fn] of checks) {
    try {
      const detail = await fn();
      log(true, label, detail);
    } catch (e) {
      log(e.status === 404 ? "warn" : false, label, `${e.status ? `HTTP ${e.status}` : e.message}`);
    }
  }

  // 2. open cloud
  console.log("\nOpen Cloud analytics");
  const key = process.env.ROBLOX_API_KEY || "";
  if (!key) {
    log("warn", "ROBLOX_API_KEY", "not set - revenue, DAU and retention will be blank");
  } else {
    const oc = new OpenCloud(key);
    const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() + 1);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 14);
    const s = start.toISOString().replace(/\.\d{3}Z$/, "Z");
    const e2 = end.toISOString().replace(/\.\d{3}Z$/, "Z");

    let authOk = false;
    for (const spec of cfg.openCloud.metrics) {
      try {
        const r = await oc.metric(universeId, spec, s, e2);
        authOk = true;
        const total = r.points.reduce((a, p) => a + (p.value || 0), 0);
        log(true, spec.metric, `${r.points.length} points, sum ${Math.round(total).toLocaleString("en-GB")}`);
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          log(false, spec.metric, "unauthorised - key needs universe-analytics / universe.analytics:read on THIS universe");
          break;
        }
        log("warn", spec.metric, err.status === 400 ? "not a valid metric name for this experience" : (err.message || "").slice(0, 60));
      }
    }
    if (authOk) log(true, "api key", "authorised");
  }

  // 3. ads
  console.log("\nAds Manager CSV drop");
  const { campaigns, files } = loadAdsFolder(path.join(ROOT, "ads-drop"));
  if (!files.length) {
    log("warn", "ads-drop folder", "no CSV yet - export one from Ads Manager with the Download button");
  } else if (!campaigns.length) {
    log(false, "ads csv parse", `${files.length} file(s) found but no rows parsed - send me the file and I will map the columns`);
  } else {
    const sum = summariseAds(campaigns);
    log(true, "ads csv parse", `${campaigns.length} campaigns, $${sum.spent.toFixed(2)} spent, ${sum.impressions.toLocaleString("en-GB")} impressions`);
  }

  // 4. alerts
  console.log("\nAlerts");
  const hook = process.env.DISCORD_WEBHOOK_URL || "";
  if (!hook) log("warn", "DISCORD_WEBHOOK_URL", "not set - alerts will be skipped");
  else if (process.argv.includes("--test-alert")) {
    try {
      await request(hook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Roblox Tracker",
          embeds: [{ title: "Tracker connected", description: "Doctor test message. Alerts are working.", color: 0x0ca30c }],
        }),
        acceptStatus: [200, 204], retries: 1,
      });
      log(true, "discord webhook", "test message delivered");
    } catch (e) { log(false, "discord webhook", e.message); }
  } else {
    log(true, "discord webhook", "set (run with --test-alert to send a test message)");
  }

  // 5. data dir
  console.log("\nStorage");
  const ts = path.join(ROOT, "data", "timeseries.csv");
  if (fs.existsSync(ts)) {
    const lines = fs.readFileSync(ts, "utf8").trim().split("\n").length - 1;
    log(true, "timeseries.csv", `${lines} samples collected`);
  } else log("warn", "timeseries.csv", "no data yet - run `npm run collect`");

  const fails = results.filter((r) => r.ok === false).length;
  const warns = results.filter((r) => r.ok === "warn").length;
  console.log("\n" + "=".repeat(60));
  console.log(`${fails ? RED : GREEN}${results.length - fails - warns} passed${OFF}, ${warns} warnings, ${fails} failures\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error("doctor crashed:", e); process.exit(1); });
