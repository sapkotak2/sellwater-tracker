// Discord webhook alerts. State is persisted so nothing fires twice.
import { request } from "./http.mjs";
import { readJson, writeJson, round } from "./store.mjs";

const COLORS = {
  good: 0x0ca30c,
  info: 0x2a78d6,
  warning: 0xfab219,
  critical: 0xd03b3b,
};

export class Alerts {
  constructor(webhookUrl, statePath, rules = {}, meta = {}) {
    this.webhookUrl = webhookUrl;
    this.statePath = statePath;
    this.rules = rules;
    this.meta = meta;
    this.state = readJson(statePath, {}) || {};
    this.queue = [];
  }

  get enabled() {
    return Boolean(this.webhookUrl);
  }

  push(level, title, description, fields = []) {
    this.queue.push({ level, title, description, fields });
  }

  evaluate({ live, records, prevRecords, adSummary, ocSeries }) {
    const r = this.rules;
    const gameName = this.meta.gameName || "Your game";

    if (r.newPeakCcu && records?.peakCcu > (prevRecords?.peakCcu ?? 0) && (prevRecords?.peakCcu ?? 0) > 0) {
      this.push("good", "New all-time peak players",
        `${gameName} just hit **${records.peakCcu}** concurrent players, beating the old record of ${prevRecords.peakCcu}.`,
        [{ name: "Previous peak", value: String(prevRecords.peakCcu), inline: true },
         { name: "Set at", value: fmt(records.peakCcuAt), inline: true }]);
    }

    if (r.ccuDropPercent && live?.ccuChange1h != null && live.ccuChange1h <= -Math.abs(r.ccuDropPercent)) {
      this.fireOnce(`ccudrop-${hourKey()}`, "warning", "Players dropping fast",
        `Concurrent players fell **${round(Math.abs(live.ccuChange1h), 0)}%** in the last hour, down to ${live.ccu}.`,
        [{ name: "24h change", value: pct(live.ccuChange24h), inline: true },
         { name: "Servers", value: String(live.serverCount ?? 0), inline: true }]);
    }

    if (r.ccuSpikePercent && live?.ccuChange1h != null && live.ccuChange1h >= Math.abs(r.ccuSpikePercent) && (live.ccu ?? 0) > 5) {
      this.fireOnce(`ccuspike-${hourKey()}`, "good", "Traffic spike",
        `Concurrent players jumped **${round(live.ccuChange1h, 0)}%** in the last hour, up to ${live.ccu}. Something is working - check where it came from.`);
    }

    if (r.gameOffline && live?.serverCount === 0 && (records?.peakCcu ?? 0) > 0) {
      this.fireOnce(`offline-${hourKey()}`, "critical", "No servers running",
        `${gameName} has zero public servers right now. Either nobody is playing or the place is unpublished / private.`);
    }

    if (r.ratingBelowPercent && live?.ratingPct != null && live.ratingPct < r.ratingBelowPercent && live.totalVotes > 20) {
      this.fireOnce(`rating-${dayKey()}`, "warning", "Rating below threshold",
        `Rating is **${round(live.ratingPct, 1)}%** (${live.upVotes} up / ${live.downVotes} down), under your ${r.ratingBelowPercent}% floor.`);
    }

    if (r.ratingDropPoints && live?.ratingChange24h != null && live.ratingChange24h <= -Math.abs(r.ratingDropPoints)) {
      this.fireOnce(`ratingdrop-${dayKey()}`, "warning", "Rating falling",
        `Rating dropped **${round(Math.abs(live.ratingChange24h), 1)} points** in 24 hours to ${round(live.ratingPct, 1)}%.`);
    }

    if (r.visitsMilestoneEvery && live?.visits) {
      const step = r.visitsMilestoneEvery;
      const milestone = Math.floor(live.visits / step) * step;
      if (milestone > 0 && milestone > (this.state.lastVisitMilestone ?? 0)) {
        this.state.lastVisitMilestone = milestone;
        this.push("good", "Visit milestone",
          `${gameName} passed **${milestone.toLocaleString("en-GB")} visits**.`);
      }
    }

    if (r.adSpendMilestoneEvery && adSummary?.spent) {
      const step = r.adSpendMilestoneEvery;
      const milestone = Math.floor(adSummary.spent / step) * step;
      if (milestone > 0 && milestone > (this.state.lastAdMilestone ?? 0)) {
        this.state.lastAdMilestone = milestone;
        this.push("info", "Ad spend milestone",
          `Ad spend crossed **$${milestone}**.`,
          [{ name: "Plays bought", value: String(adSummary.plays ?? 0), inline: true },
           { name: "Cost per play", value: adSummary.cpp != null ? `$${round(adSummary.cpp, 4)}` : "n/a", inline: true },
           { name: "CTR", value: adSummary.ctr != null ? `${round(adSummary.ctr, 2)}%` : "n/a", inline: true }]);
      }
    }

    const revPoints = ocSeries?.DailyRevenue || [];
    if (r.revenueMilestoneEvery && revPoints.length) {
      const total = revPoints.reduce((a, p) => a + (p.value || 0), 0);
      const step = r.revenueMilestoneEvery;
      const milestone = Math.floor(total / step) * step;
      if (milestone > 0 && milestone > (this.state.lastRevenueMilestone ?? 0)) {
        this.state.lastRevenueMilestone = milestone;
        this.push("good", "Revenue milestone",
          `Tracked revenue passed **${milestone.toLocaleString("en-GB")} Robux**.`);
      }
    }
  }

  fireOnce(key, level, title, description, fields = []) {
    if (this.state[`fired:${key}`]) return;
    this.state[`fired:${key}`] = Date.now();
    this.push(level, title, description, fields);
  }

  buildDigest({ live, records, daily, adSummary }) {
    const y = daily[daily.length - 1] || {};
    const fields = [
      { name: "Visits yesterday", value: num(y.visitsGained), inline: true },
      { name: "Peak players", value: num(y.peakCcu), inline: true },
      { name: "Average players", value: num(y.avgCcu), inline: true },
      { name: "Rating", value: live.ratingPct != null ? `${round(live.ratingPct, 1)}%` : "n/a", inline: true },
      { name: "Favourites", value: num(live.favorites), inline: true },
      { name: "All-time peak", value: num(records.peakCcu), inline: true },
    ];
    if (adSummary?.spent) {
      fields.push(
        { name: "Ad spend", value: `$${round(adSummary.spent, 2)}`, inline: true },
        { name: "Cost per play", value: adSummary.cpp != null ? `$${round(adSummary.cpp, 4)}` : "n/a", inline: true },
        { name: "CTR", value: adSummary.ctr != null ? `${round(adSummary.ctr, 2)}%` : "n/a", inline: true }
      );
    }
    this.push("info", "Daily summary", `Yesterday on ${this.meta.gameName || "your game"}.`, fields);
  }

  async flush() {
    if (!this.enabled || !this.queue.length) {
      this.save();
      return 0;
    }
    let sent = 0;
    // Discord accepts up to 10 embeds per message.
    for (let i = 0; i < this.queue.length; i += 10) {
      const batch = this.queue.slice(i, i + 10);
      const payload = {
        username: "Roblox Tracker",
        embeds: batch.map((a) => ({
          title: a.title,
          description: a.description,
          color: COLORS[a.level] ?? COLORS.info,
          fields: a.fields?.length ? a.fields : undefined,
          timestamp: new Date().toISOString(),
          footer: { text: this.meta.gameName || "Roblox tracker" },
          url: this.meta.gameUrl || undefined,
        })),
      };
      try {
        await request(this.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          acceptStatus: [200, 204],
          retries: 2,
        });
        sent += batch.length;
      } catch (e) {
        console.error("  alert delivery failed:", e.message);
      }
    }
    this.queue = [];
    this.save();
    return sent;
  }

  save() {
    // Keep the fired-key ledger from growing forever.
    const cutoff = Date.now() - 30 * 86400000;
    for (const k of Object.keys(this.state)) {
      if (k.startsWith("fired:") && this.state[k] < cutoff) delete this.state[k];
    }
    writeJson(this.statePath, this.state);
  }
}

const num = (v) => (v == null ? "n/a" : Number(v).toLocaleString("en-GB"));
const pct = (v) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${round(v, 1)}%`);
const fmt = (iso) => (iso ? new Date(iso).toUTCString().replace(" GMT", " UTC") : "n/a");
const hourKey = () => new Date().toISOString().slice(0, 13);
const dayKey = () => new Date().toISOString().slice(0, 10);
