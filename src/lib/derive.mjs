// Everything computed rather than fetched: rates, deltas, peaks, health.
import { round } from "./store.mjs";

const HOUR = 3600000;
const DAY = 86400000;

const at = (r) => r.epoch || Date.parse(r.iso);

function nearest(rows, targetMs) {
  let best = null, bestGap = Infinity;
  for (const r of rows) {
    const gap = Math.abs(at(r) - targetMs);
    if (gap < bestGap) { bestGap = gap; best = r; }
  }
  // only trust a comparison point within 25% of the window
  return best && bestGap < Math.max(HOUR, 0.25 * DAY) ? best : null;
}

function pctChange(now, then) {
  if (now == null || then == null || then === 0) return null;
  return ((now - then) / then) * 100;
}

export function buildRecords(rows, prev = {}) {
  const rec = {
    peakCcu: prev.peakCcu ?? 0,
    peakCcuAt: prev.peakCcuAt ?? null,
    peakVisitsPerDay: prev.peakVisitsPerDay ?? 0,
    peakVisitsPerDayAt: prev.peakVisitsPerDayAt ?? null,
    bestRatingPct: prev.bestRatingPct ?? 0,
    bestRatingPctAt: prev.bestRatingPctAt ?? null,
    firstSeen: prev.firstSeen ?? (rows[0]?.iso || null),
  };
  for (const r of rows) {
    if (r.ccu != null && r.ccu > rec.peakCcu) { rec.peakCcu = r.ccu; rec.peakCcuAt = r.iso; }
    if (r.ratingPct != null && r.ratingPct > rec.bestRatingPct) {
      rec.bestRatingPct = r.ratingPct; rec.bestRatingPctAt = r.iso;
    }
  }
  const daily = dailyVisits(rows);
  for (const d of daily) {
    if (d.visitsGained > rec.peakVisitsPerDay) {
      rec.peakVisitsPerDay = d.visitsGained; rec.peakVisitsPerDayAt = d.date;
    }
  }
  return rec;
}

// Visits is a cumulative counter, so daily growth is the difference between the
// last reading of each UTC day.
export function dailyVisits(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (r.visits == null) continue;
    const day = new Date(at(r)).toISOString().slice(0, 10);
    const cur = byDay.get(day);
    if (!cur || at(r) > at(cur)) byDay.set(day, r);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const out = [];
  for (let i = 0; i < days.length; i++) {
    const [date, row] = days[i];
    const prev = i > 0 ? days[i - 1][1] : null;
    out.push({
      date,
      visits: row.visits,
      visitsGained: prev ? Math.max(0, row.visits - prev.visits) : null,
      favorites: row.favorites,
      favoritesGained: prev && row.favorites != null && prev.favorites != null
        ? row.favorites - prev.favorites : null,
      upVotes: row.upVotes,
      downVotes: row.downVotes,
      ratingPct: row.ratingPct,
      peakCcu: Math.max(...rows.filter((x) =>
        new Date(at(x)).toISOString().slice(0, 10) === date && x.ccu != null
      ).map((x) => x.ccu), 0) || null,
      avgCcu: avg(rows.filter((x) =>
        new Date(at(x)).toISOString().slice(0, 10) === date
      ).map((x) => x.ccu)),
    });
  }
  return out;
}

const avg = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 2) : null;
};

export function deriveLive(rows, snap) {
  const now = rows[rows.length - 1];
  if (!now) return {};
  const t = at(now);

  const h1 = nearest(rows, t - HOUR);
  const h6 = nearest(rows, t - 6 * HOUR);
  const d1 = nearest(rows, t - DAY);
  const d7 = nearest(rows, t - 7 * DAY);

  const servers = snap?.servers || [];
  const capacity = servers.reduce((a, s) => a + (s.maxPlayers || 0), 0);
  const seated = servers.reduce((a, s) => a + (s.playing || 0), 0);
  const full = servers.filter((s) => s.maxPlayers && s.playing >= s.maxPlayers).length;

  const badges = snap?.badges || [];
  const sortedBadges = [...badges].sort((a, b) => b.awardedCount - a.awardedCount);
  const entryBadge = sortedBadges[0];

  const uptimeRows = rows.slice(-Math.min(rows.length, 288)); // ~last day at 5 min
  const withPlayers = uptimeRows.filter((r) => (r.ccu ?? 0) > 0).length;

  return {
    ccu: now.ccu,
    ccuChange1h: round(pctChange(now.ccu, h1?.ccu), 1),
    ccuChange6h: round(pctChange(now.ccu, h6?.ccu), 1),
    ccuChange24h: round(pctChange(now.ccu, d1?.ccu), 1),
    ccuChange7d: round(pctChange(now.ccu, d7?.ccu), 1),

    visits: now.visits,
    visitsLast24h: d1?.visits != null && now.visits != null ? now.visits - d1.visits : null,
    visitsLast7d: d7?.visits != null && now.visits != null ? now.visits - d7.visits : null,
    visitsPerHour: h1?.visits != null && now.visits != null ? now.visits - h1.visits : null,

    favorites: now.favorites,
    favoritesLast24h: d1?.favorites != null && now.favorites != null
      ? now.favorites - d1.favorites : null,
    favoritesPerVisitPct: now.visits ? round((now.favorites / now.visits) * 100, 3) : null,

    upVotes: now.upVotes,
    downVotes: now.downVotes,
    ratingPct: now.ratingPct,
    ratingChange24h: round((now.ratingPct ?? 0) - (d1?.ratingPct ?? now.ratingPct ?? 0), 2),
    totalVotes: (now.upVotes ?? 0) + (now.downVotes ?? 0),
    votesPerVisitPct: now.visits
      ? round((((now.upVotes ?? 0) + (now.downVotes ?? 0)) / now.visits) * 100, 3) : null,

    serverCount: servers.length,
    serverCapacity: capacity,
    serversFull: full,
    avgServerFillPct: capacity ? round((seated / capacity) * 100, 1) : null,
    avgPing: avg(servers.map((s) => s.ping)),
    avgFps: avg(servers.map((s) => s.fps)),
    medianServerPlayers: median(servers.map((s) => s.playing)),

    badgeCount: badges.length,
    badgeAwardsTotal: badges.reduce((a, b) => a + (b.awardedCount || 0), 0),
    badgeAwardsPastDay: badges.reduce((a, b) => a + (b.pastDayAwardedCount || 0), 0),
    entryBadgeWinRate: entryBadge?.winRatePercentage ?? null,
    badgeFunnel: sortedBadges.slice(0, 12).map((b) => ({
      name: b.name,
      awarded: b.awardedCount,
      pastDay: b.pastDayAwardedCount,
      winRate: b.winRatePercentage,
      shareOfEntry: entryBadge?.awardedCount
        ? round((b.awardedCount / entryBadge.awardedCount) * 100, 1) : null,
    })),

    uptimePct: uptimeRows.length ? round((withPlayers / uptimeRows.length) * 100, 1) : null,
    samples: rows.length,
    trackingSince: rows[0]?.iso ?? null,
  };
}

// Ties the ad spend to what actually happened in the game.
export function deriveAdEconomics(adSummary, live, ocSeries, robuxToUsd) {
  if (!adSummary || !adSummary.spent) return null;
  const revenuePoints = ocSeries?.DailyRevenue || [];
  const revenueRobux = revenuePoints.reduce((a, p) => a + (p.value || 0), 0);
  const revenueUsd = revenueRobux * (robuxToUsd || 0);

  return {
    spent: round(adSummary.spent, 2),
    plays: adSummary.plays,
    cpp: round(adSummary.cpp, 4),
    costPerPlaytimeHour: round(adSummary.costPerPlaytimeHour, 3),
    revenueRobux: round(revenueRobux, 0),
    revenueUsd: round(revenueUsd, 2),
    roasPct: adSummary.spent ? round((revenueUsd / adSummary.spent) * 100, 1) : null,
    netUsd: round(revenueUsd - adSummary.spent, 2),
    breakEvenCpp: adSummary.plays && revenueUsd
      ? round(revenueUsd / adSummary.plays, 4) : null,
    playsPerImpressionPct: round(adSummary.playsPerImpression, 3),
    // What one advertised play is worth once you know revenue per play.
    verdict: null,
  };
}

function median(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : round((v[m - 1] + v[m]) / 2, 1);
}

export { pctChange, nearest, avg, median };
