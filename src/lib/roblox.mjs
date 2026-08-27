// Public Roblox web API client. No authentication required for anything here.
import { request, pool } from "./http.mjs";

export class Roblox {
  constructor({ timeoutMs = 15000, retries = 3, proxyHost = "" } = {}) {
    this.opts = { timeoutMs, retries, proxyHost };
  }

  #get(url, extra = {}) {
    return request(url, { ...this.opts, ...extra }).then((r) => r.data);
  }

  // placeId -> universeId. Everything else keys off universeId.
  async universeIdFromPlace(placeId) {
    const d = await this.#get(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
    );
    return d?.universeId ?? null;
  }

  // Core record: name, playing (live CCU), visits, favoritedCount, maxPlayers,
  // created, updated, creator, genre, price.
  async gameDetails(universeId) {
    const d = await this.#get(
      `https://games.roblox.com/v1/games?universeIds=${universeId}`
    );
    return d?.data?.[0] ?? null;
  }

  async votes(universeId) {
    const d = await this.#get(
      `https://games.roblox.com/v1/games/${universeId}/votes`
    );
    return { upVotes: d?.upVotes ?? null, downVotes: d?.downVotes ?? null };
  }

  async favoritesCount(universeId) {
    const d = await this.#get(
      `https://games.roblox.com/v1/games/${universeId}/favorites/count`
    );
    return d?.favoritesCount ?? null;
  }

  // Live server list. Each entry: id, maxPlayers, playing, fps, ping.
  // Paginated 100 at a time; pages caps how deep we walk on big games.
  async publicServers(universeId, pages = 3) {
    const servers = [];
    let cursor = "";
    for (let p = 0; p < pages; p++) {
      const url =
        `https://games.roblox.com/v1/games/${universeId}/servers/Public` +
        `?sortOrder=Asc&excludeFullGames=false&limit=100` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const d = await this.#get(url);
      if (!d?.data?.length) break;
      servers.push(
        ...d.data.map((s) => ({
          id: s.id,
          playing: s.playing ?? 0,
          maxPlayers: s.maxPlayers ?? 0,
          fps: s.fps ?? null,
          ping: s.ping ?? null,
        }))
      );
      cursor = d.nextPageCursor || "";
      if (!cursor) break;
    }
    return servers;
  }

  // Badges double as a free retention funnel: awardedCount is cumulative,
  // pastDayAwardedCount is a daily rate, winRatePercentage is conversion.
  async badges(universeId, pages = 3) {
    const out = [];
    let cursor = "";
    for (let p = 0; p < pages; p++) {
      const url =
        `https://badges.roblox.com/v1/universes/${universeId}/badges` +
        `?limit=100&sortOrder=Asc` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const d = await this.#get(url);
      if (!d?.data?.length) break;
      out.push(
        ...d.data.map((b) => ({
          id: b.id,
          name: b.name,
          enabled: b.enabled,
          awardedCount: b.statistics?.awardedCount ?? 0,
          pastDayAwardedCount: b.statistics?.pastDayAwardedCount ?? 0,
          winRatePercentage: b.statistics?.winRatePercentage ?? 0,
        }))
      );
      cursor = d.nextPageCursor || "";
      if (!cursor) break;
    }
    return out;
  }

  // Roblox has moved this one more than once and every unauthenticated variant
  // known as of Aug 2026 returns 404, so the whole chain is tried and an empty
  // list is returned rather than an error. Add a working URL here if you find
  // one; everything else on the dashboard is unaffected.
  async gamePasses(universeId, placeId) {
    const candidates = [
      `https://games.roblox.com/v1/games/${universeId}/game-passes?limit=100&sortOrder=Asc`,
      `https://apis.roblox.com/game-passes/v1/universes/${universeId}/creator-game-passes?count=100`,
      placeId ? `https://games.roblox.com/v1/games/${placeId}/game-passes?limit=100&sortOrder=Asc` : null,
    ].filter(Boolean);

    for (const url of candidates) {
      try {
        const d = await this.#get(url);
        const list = d?.data ?? d?.gamePasses ?? null;
        if (!Array.isArray(list)) continue;
        return list.map((g) => ({
          id: g.id ?? g.gamePassId ?? null,
          name: g.name ?? g.displayName ?? "Unnamed pass",
          price: g.price ?? g.priceInRobux ?? null,
        }));
      } catch {
        continue;
      }
    }
    return [];
  }

  async icon(universeId) {
    const d = await this.#get(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}` +
        `&size=512x512&format=Png&isCircular=false`
    );
    return d?.data?.[0]?.imageUrl ?? null;
  }

  async media(universeId) {
    const d = await this.#get(
      `https://games.roblox.com/v2/games/${universeId}/media`
    );
    return d?.data ?? [];
  }

  // Every experience owned by a user or a group - used for multi-game mode.
  async gamesByUser(userId) {
    const d = await this.#get(
      `https://games.roblox.com/v2/users/${userId}/games?accessFilter=Public&limit=50&sortOrder=Asc`
    );
    return d?.data ?? [];
  }

  async gamesByGroup(groupId) {
    const d = await this.#get(
      `https://games.roblox.com/v2/groups/${groupId}/gamesV2?accessFilter=Public&limit=50&sortOrder=Asc`
    );
    return d?.data ?? [];
  }

  // One shot: everything public we can get about a universe.
  async fullSnapshot(universeId, cfg = {}) {
    const want = {
      servers: true,
      badges: true,
      gamePasses: true,
      serverPageLimit: 3,
      ...cfg,
    };

    const jobs = [
      ["details", () => this.gameDetails(universeId)],
      ["votes", () => this.votes(universeId)],
      ["favorites", () => this.favoritesCount(universeId)],
      ["icon", () => this.icon(universeId)],
    ];
    if (want.servers)
      jobs.push(["servers", () => this.publicServers(universeId, want.serverPageLimit)]);
    if (want.badges) jobs.push(["badges", () => this.badges(universeId)]);
    if (want.gamePasses)
      jobs.push(["gamePasses", () => this.gamePasses(universeId, cfg.placeId)]);

    const results = await pool(jobs, 4, ([, fn]) => fn());

    const snap = { universeId, errors: {} };
    results.forEach((r, i) => {
      const key = jobs[i][0];
      if (r.ok) snap[key] = r.value;
      else {
        snap[key] = null;
        snap.errors[key] = String(r.error?.message || r.error);
      }
    });
    return snap;
  }
}
