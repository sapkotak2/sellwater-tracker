#!/usr/bin/env node
// One polling cycle. Safe to run every minute or once a day - it decides which
// of the expensive jobs are due and skips the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Roblox } from "./lib/roblox.mjs";
import { OpenCloud } from "./lib/opencloud.mjs";
import { loadAdsFolder, summariseAds } from "./lib/ads.mjs";
import { Alerts } from "./lib/alerts.mjs";
import {
  ensureDirs, writeJson, readJson, appendTimeseries, readTimeseries,
  compactTimeseries, round,
} from "./lib/store.mjs";
import { buildRecords, dailyVisits, deriveLive, deriveAdEconomics } from "./lib/derive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const args = new Set(process.argv.slice(2));

function loadConfig() {
  const cfg = readJson(path.join(ROOT, "config.json"));
  if (!cfg) throw new Error("config.json missing or invalid");
  const envPlace = process.env.ROBLOX_PLACE_ID;
  if (envPlace) cfg.game.placeId = Number(envPlace);
  if (!cfg.game.placeId && cfg.game.placeUrl) {
    const m = String(cfg.game.placeUrl).match(/\/games\/(\d+)/);
    if (m) cfg.game.placeId = Number(m[1]);
  }
  return cfg;
}

async function main() {
  const started = Date.now();
  ensureDirs(ROOT);
  const cfg = loadConfig();

  if (!cfg.game.placeId && !cfg.game.universeId) {
    console.error(
      "\nNo game configured.\n" +
      "Open config.json and set game.placeUrl to your experience link, for example\n" +
      '  "placeUrl": "https://www.roblox.com/games/123456789/My-Game"\n' +
      "or set game.placeId to just the number. Then run this again.\n"
    );
    process.exit(2);
  }

  const rbx = new Roblox({
    timeoutMs: cfg.collect.requestTimeoutMs,
    retries: cfg.collect.retries,
    proxyHost: cfg.collect.proxyHost,
  });

  // ---- universe id (cached, it never changes) -----------------------------
  const metaPath = path.join(DATA, "meta.json");
  const meta = readJson(metaPath, {}) || {};
  let universeId = cfg.game.universeId || meta.universeId;
  if (!universeId) {
    universeId = await rbx.universeIdFromPlace(cfg.game.placeId);
    if (!universeId) throw new Error(`could not resolve universe for place ${cfg.game.placeId}`);
    meta.universeId = universeId;
  }
  console.log(`> universe ${universeId} (place ${cfg.game.placeId ?? "cached"})`);

  // ---- public snapshot ----------------------------------------------------
  const snap = await rbx.fullSnapshot(universeId, { ...cfg.collect, placeId: cfg.game.placeId });
  const d = snap.details || {};
  const up = snap.votes?.upVotes ?? null;
  const down = snap.votes?.downVotes ?? null;
  const ratingPct = up != null && down != null && up + down > 0
    ? (up / (up + down)) * 100 : null;

  const servers = snap.servers || [];
  const capacity = servers.reduce((a, s) => a + (s.maxPlayers || 0), 0);
  const seated = servers.reduce((a, s) => a + (s.playing || 0), 0);
  const badges = snap.badges || [];

  const now = new Date();
  const row = {
    iso: now.toISOString(),
    epoch: now.getTime(),
    ccu: d.playing ?? null,
    visits: d.visits ?? null,
    favorites: snap.favorites ?? d.favoritedCount ?? null,
    upVotes: up,
    downVotes: down,
    ratingPct: round(ratingPct, 3),
    servers: servers.length,
    avgServerFill: capacity ? round((seated / capacity) * 100, 2) : null,
    avgPing: avgOf(servers.map((s) => s.ping)),
    avgFps: avgOf(servers.map((s) => s.fps)),
    badgeAwardsTotal: badges.reduce((a, b) => a + (b.awardedCount || 0), 0) || null,
    badgeAwardsPastDay: badges.reduce((a, b) => a + (b.pastDayAwardedCount || 0), 0) || null,
  };

  const tsPath = path.join(DATA, "timeseries.csv");
  appendTimeseries(tsPath, row);
  const rows = readTimeseries(tsPath);
  console.log(`> ccu ${row.ccu ?? "?"} | visits ${fmtNum(row.visits)} | rating ${row.ratingPct != null ? round(row.ratingPct, 1) + "%" : "?"} | ${servers.length} servers`);

  if (Object.keys(snap.errors || {}).length) {
    for (const [k, v] of Object.entries(snap.errors)) console.warn(`  ! ${k}: ${v}`);
  }

  // ---- open cloud analytics (daily data, no need to poll it hourly) -------
  const ocPath = path.join(DATA, "analytics.json");
  let oc = readJson(ocPath, null);
  const ocDue = args.has("--force-analytics") ||
    !oc || (Date.now() - Date.parse(oc.fetchedAt || 0)) > 3 * 3600000;
  const apiKey = process.env.ROBLOX_API_KEY || "";

  if (cfg.collect.openCloud && apiKey && ocDue) {
    console.log("> querying Open Cloud analytics ...");
    const client = new OpenCloud(apiKey);
    try {
      const harvest = await client.harvest(
        universeId, cfg.openCloud.metrics, cfg.openCloud.lookbackDays, cfg.openCloud.breakdowns
      );
      oc = { fetchedAt: new Date().toISOString(), ...harvest };
      writeJson(ocPath, oc);
      console.log(`  ${harvest.supported.length} metrics live: ${harvest.supported.join(", ") || "none"}`);
      if (harvest.unsupported.length)
        console.log(`  ${harvest.unsupported.length} unavailable (${harvest.unsupported.slice(0, 4).map((u) => u.metric).join(", ")}${harvest.unsupported.length > 4 ? " ..." : ""})`);
    } catch (e) {
      console.warn(`  ! analytics failed: ${e.message}`);
    }
  } else if (cfg.collect.openCloud && !apiKey) {
    console.log("> Open Cloud skipped (no ROBLOX_API_KEY set)");
  }

  // ---- ads csv drop -------------------------------------------------------
  let adSummary = null, adCampaigns = [];
  if (cfg.collect.ads) {
    const { campaigns, files } = loadAdsFolder(path.join(ROOT, "ads-drop"));
    adCampaigns = campaigns;
    if (campaigns.length) {
      adSummary = summariseAds(campaigns);
      console.log(`> ads: ${campaigns.length} campaigns from ${files.length} file(s), $${round(adSummary.spent, 2)} spent`);
    }
  }

  // ---- competitors --------------------------------------------------------
  const competitors = [];
  if (cfg.collect.competitors) {
    for (const c of cfg.competitors || []) {
      try {
        const uid = c.universeId || (await rbx.universeIdFromPlace(c.placeId));
        const det = await rbx.gameDetails(uid);
        const v = await rbx.votes(uid);
        const rec = {
          name: c.name || det?.name, universeId: uid, placeId: c.placeId,
          ccu: det?.playing ?? null, visits: det?.visits ?? null,
          favorites: det?.favoritedCount ?? null,
          ratingPct: v.upVotes + v.downVotes > 0
            ? round((v.upVotes / (v.upVotes + v.downVotes)) * 100, 2) : null,
        };
        competitors.push(rec);
        const cf = path.join(DATA, "competitors", `${uid}.csv`);
        if (!fs.existsSync(cf)) fs.writeFileSync(cf, "iso,ccu,visits,favorites,ratingPct\n");
        fs.appendFileSync(cf, `${row.iso},${rec.ccu ?? ""},${rec.visits ?? ""},${rec.favorites ?? ""},${rec.ratingPct ?? ""}\n`);
      } catch (e) {
        console.warn(`  ! competitor ${c.name}: ${e.message}`);
      }
    }
    if (competitors.length) console.log(`> competitors: ${competitors.map((c) => `${c.name} ${c.ccu}`).join(" | ")}`);
  }

  // ---- derive -------------------------------------------------------------
  const prevRecords = readJson(path.join(DATA, "records.json"), {}) || {};
  const records = buildRecords(rows, prevRecords);
  const daily = dailyVisits(rows);
  const live = deriveLive(rows, snap);
  const adEcon = deriveAdEconomics(adSummary, live, oc?.series, cfg.site.robuxToUsd);

  const latest = {
    generatedAt: row.iso,
    game: {
      universeId,
      placeId: cfg.game.placeId ?? d.rootPlaceId ?? null,
      name: d.name || cfg.game.name,
      description: d.description || null,
      creator: d.creator || null,
      created: d.created || null,
      updated: d.updated || null,
      maxPlayers: d.maxPlayers ?? null,
      genre: d.genre || null,
      price: d.price ?? null,
      icon: snap.icon || null,
      url: `https://www.roblox.com/games/${cfg.game.placeId ?? d.rootPlaceId ?? ""}`,
    },
    live,
    records,
    servers: servers
      .slice()
      .sort((a, b) => (b.playing || 0) - (a.playing || 0))
      .slice(0, 60),
    badges: (snap.badges || []).slice(0, 40),
    gamePasses: snap.gamePasses || [],
    ads: { summary: adSummary, economics: adEcon, campaigns: adCampaigns },
    competitors,
    analytics: oc
      ? { fetchedAt: oc.fetchedAt, supported: oc.supported, unsupported: oc.unsupported, series: oc.series }
      : null,
    settings: { robuxToUsd: cfg.site.robuxToUsd, timezone: cfg.site.timezone },
    health: { errors: snap.errors || {}, runtimeMs: Date.now() - started },
  };

  writeJson(path.join(DATA, "latest.json"), latest);
  writeJson(path.join(DATA, "records.json"), records);
  writeJson(path.join(DATA, "daily.json"), daily);
  writeJson(metaPath, meta);
  writeJson(path.join(DATA, "history.json"), thin(rows, 2000));

  // ---- alerts -------------------------------------------------------------
  if (cfg.alerts.enabled) {
    const alerts = new Alerts(
      process.env.DISCORD_WEBHOOK_URL || "",
      path.join(DATA, "alert-state.json"),
      cfg.alerts.rules,
      { gameName: latest.game.name, gameUrl: latest.game.url }
    );
    alerts.evaluate({ live, records, prevRecords, adSummary, ocSeries: oc?.series });

    const hourNow = new Date().getUTCHours();
    const digestKey = `digest-${new Date().toISOString().slice(0, 10)}`;
    if (cfg.alerts.dailyDigestHourUtc === hourNow && !alerts.state[digestKey] && daily.length > 1) {
      alerts.state[digestKey] = Date.now();
      alerts.buildDigest({ live, records, daily, adSummary });
    }
    const sent = await alerts.flush();
    if (sent) console.log(`> ${sent} alert(s) sent to Discord`);
    else if (!alerts.enabled && alerts.queue?.length) console.log("> alerts queued but no DISCORD_WEBHOOK_URL set");
  }

  const kept = compactTimeseries(tsPath);
  console.log(`> done in ${Date.now() - started}ms${kept ? `, ${kept} rows retained` : ""}`);
}

function thin(rows, max) {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out = rows.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

function avgOf(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 2) : null;
}

const fmtNum = (v) => (v == null ? "?" : Number(v).toLocaleString("en-GB"));

main().catch((e) => {
  const msg = String(e?.message || e);
  console.error("collect failed:", msg);
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|abort|403/i.test(msg)) {
    console.error(
      '\nThis machine cannot reach Roblox directly. Set "proxyHost": "roproxy.com"\n' +
      'inside "collect" in config.json, or run `npm run doctor` for a full report.'
    );
  }
  process.exit(1);
});
