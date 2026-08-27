// Roblox Open Cloud Analytics Query API.
// POST https://apis.roblox.com/analytics-query-api/v1/universes/{universeId}/metrics
// Auth: x-api-key header, scope "universe-analytics -> universe.analytics:read".
// Returns 200 (done) or 202 (long-running operation you poll).
import { request } from "./http.mjs";

const BASE = "https://apis.roblox.com/analytics-query-api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The API is young and metric names differ per product area, so the response is
// walked tolerantly: anything that looks like a time/value pair is harvested and
// the raw payload is kept alongside it.
function normalize(payload) {
  const points = [];
  const seen = new Set();

  const timeKeys = ["time", "timestamp", "date", "startTime", "bucket", "periodStart"];
  const valueKeys = ["value", "count", "metricValue", "amount", "total"];

  const walk = (node, breadcrumb) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, breadcrumb));
      return;
    }
    if (typeof node !== "object") return;

    const tKey = timeKeys.find((k) => typeof node[k] === "string" || typeof node[k] === "number");
    const vKey = valueKeys.find((k) => typeof node[k] === "number");

    if (tKey && vKey) {
      const t = typeof node[tKey] === "number"
        ? new Date(node[tKey] * (String(node[tKey]).length > 11 ? 1 : 1000)).toISOString()
        : new Date(node[tKey]).toISOString();
      const series = breadcrumb || node.breakdown || node.dimension || "total";
      const key = `${series}|${t}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push({ time: t, value: node[vKey], series: String(series) });
      }
      return;
    }

    // A breakdown container names its series, then holds the points beneath.
    const label =
      node.breakdownValue ?? node.dimensionValue ?? node.name ?? node.key ?? null;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "object") walk(v, label != null ? String(label) : breadcrumb);
    }
  };

  walk(payload, null);
  points.sort((a, b) => a.time.localeCompare(b.time));
  return points;
}

export class OpenCloud {
  constructor(apiKey, { timeoutMs = 30000, retries = 2 } = {}) {
    this.apiKey = apiKey;
    this.opts = { timeoutMs, retries };
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async #poll(path, maxWaitMs = 60000) {
    const started = Date.now();
    let delay = 1000;
    const url = path.startsWith("http")
      ? path
      : `${BASE}/${String(path).replace(/^\/+/, "")}`;

    while (Date.now() - started < maxWaitMs) {
      await sleep(delay);
      const { data } = await request(url, {
        ...this.opts,
        headers: { "x-api-key": this.apiKey },
        acceptStatus: [200, 202],
      });
      if (data?.done === true || data?.response || data?.results) return data;
      delay = Math.min(delay * 1.6, 8000);
    }
    throw new Error(`analytics operation timed out: ${url}`);
  }

  // One metric over one window. Returns { metric, points, raw } or throws.
  async metric(universeId, spec, startTime, endTime) {
    const body = {
      metric: spec.metric,
      granularity: spec.granularity || "OneDay",
      startTime,
      endTime,
    };
    if (spec.breakdown?.length) body.breakdown = spec.breakdown;
    if (spec.filter?.length) body.filter = spec.filter;
    if (spec.limit) body.limit = spec.limit;

    const { status, data } = await request(
      `${BASE}/v1/universes/${universeId}/metrics`,
      {
        ...this.opts,
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        acceptStatus: [200, 202],
      }
    );

    let payload = data;
    if (status === 202 || data?.done === false) {
      const path = data?.path || data?.operationPath || data?.name || data?.operation;
      if (!path) throw new Error(`202 with no operation path for ${spec.metric}`);
      payload = await this.#poll(path);
    }

    return {
      metric: spec.metric,
      granularity: body.granularity,
      breakdown: body.breakdown || null,
      points: normalize(payload),
      raw: payload,
    };
  }

  // Walks the configured metric list, keeping what works and reporting what does
  // not. Unsupported metric names come back as 400 and are simply recorded.
  async harvest(universeId, metricSpecs, lookbackDays, breakdowns = {}) {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1); // endTime is exclusive
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - lookbackDays);

    const startTime = start.toISOString().replace(/\.\d{3}Z$/, "Z");
    const endTime = end.toISOString().replace(/\.\d{3}Z$/, "Z");

    const series = {};
    const supported = [];
    const unsupported = [];

    for (const spec of metricSpecs) {
      try {
        const r = await this.metric(universeId, spec, startTime, endTime);
        series[spec.metric] = r.points;
        supported.push(spec.metric);
      } catch (e) {
        unsupported.push({ metric: spec.metric, reason: shortReason(e) });
        continue;
      }

      // Optional breakdown pass for the metrics worth slicing.
      const bd = breakdowns[spec.metric];
      if (bd?.length) {
        for (const dim of bd) {
          try {
            const r = await this.metric(
              universeId,
              { ...spec, breakdown: [dim], limit: 12 },
              startTime,
              endTime
            );
            series[`${spec.metric}__by__${dim}`] = r.points;
          } catch {
            /* breakdown unavailable, the base metric still stands */
          }
        }
      }
    }

    return { window: { startTime, endTime }, series, supported, unsupported };
  }
}

function shortReason(e) {
  if (e?.status === 401 || e?.status === 403)
    return "unauthorised - check the API key scope includes universe.analytics:read and the key is bound to this universe";
  if (e?.status === 400) return "metric name not accepted by the API";
  if (e?.status === 429) return "rate limited";
  return String(e?.message || e).slice(0, 160);
}
