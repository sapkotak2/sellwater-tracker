// Minimal fetch wrapper: timeout, retry with backoff, optional proxy host swap.
// Zero dependencies. Node 18+.

const UA = "sellwater-tracker/1.0 (+https://github.com/)";

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} on ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function applyProxy(url, proxyHost) {
  if (!proxyHost) return url;
  // roproxy style mirrors: games.roblox.com -> games.roproxy.com
  return url.replace(/\.roblox\.com/g, `.${proxyHost}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 15000,
    retries = 3,
    proxyHost = "",
    acceptStatus = [200],
  } = opts;

  const target = applyProxy(url, proxyHost);
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        method,
        headers: { "User-Agent": UA, Accept: "application/json", ...headers },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const text = await res.text();

      if (!acceptStatus.includes(res.status)) {
        // 429 and 5xx are worth retrying, 4xx generally is not.
        const retryable = res.status === 429 || res.status >= 500;
        const err = new HttpError(res.status, target, text.slice(0, 500));
        if (!retryable || attempt === retries) throw err;
        lastErr = err;
        const wait = res.status === 429 ? 5000 * (attempt + 1) : 800 * 2 ** attempt;
        await sleep(wait);
        continue;
      }

      if (!text) return { status: res.status, data: null };
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return { status: res.status, data: text };
      }
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt === retries) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw lastErr || new Error(`request failed: ${target}`);
}

// Runs tasks with a small concurrency cap so we never hammer Roblox.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (e) {
        out[idx] = { ok: false, error: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
