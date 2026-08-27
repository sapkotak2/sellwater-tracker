# Roblox Live Tracker

A 24/7 stats tracker and dashboard for one Roblox experience. It polls every
public endpoint Roblox exposes, pulls the private analytics that need an API
key, merges your Ads Manager exports, benchmarks you against rival games, and
pings Discord when something happens.

Zero npm dependencies. Node 18+. Runs on GitHub Actions for free, in Docker, or
on your own machine.

---

## See it before you set it up

```bash
npm run demo
```

That writes sample data and builds `dist/dashboard.html`. Open it with a double
click. Everything you see is fake but every chart is real code. Delete the
`data/` folder when you are done.

---

## Setup

### 1. Your game is already configured

`config.json` is filled in for `[money] Sell Water! [water]`, place `71265564299629`,
universe `10475370654`, both verified against the live API. Nothing to edit.

To point it at a different experience later, replace `game.placeUrl` with that
link and set `placeId` and `universeId` back to `null`.

### 2. Check everything works

```bash
npm run doctor
```

This hits every endpoint one at a time and tells you exactly what works, what is
missing, and what is misconfigured. Run it any time something looks wrong.

### 3. Collect

```bash
npm run track
```

`collect` writes a row to `data/timeseries.csv` and refreshes the JSON files.
`build` renders `dist/dashboard.html` and `docs/` for hosting.

---

## Running it 24/7

### Option A: GitHub Actions plus Pages (free, nothing to maintain)

1. Push this folder to a new GitHub repo.
2. Settings -> Secrets and variables -> Actions -> New repository secret:
   - `ROBLOX_API_KEY` (optional, unlocks revenue and retention)
   - `DISCORD_WEBHOOK_URL` (optional, alerts)
3. Settings -> Pages -> Source: Deploy from a branch -> `main` -> `/docs`.
4. Actions tab -> track -> Run workflow, to prove it works before waiting.

It now runs every 10 minutes forever and commits each sample to the repo, so
your history is version controlled and you can never lose it. Your dashboard is
at `https://<your-username>.github.io/<repo>/`.

Two things to know:

- GitHub disables scheduled workflows in repos with no commits for 60 days. This
  one commits data on every run, so it keeps itself alive.
- `*/10` is a request, not a promise. GitHub queues cron jobs and busy hours can
  push a run 10 to 20 minutes late. If you need exact one minute resolution, use
  Option B.

### Option B: Docker on a VPS or an always-on machine

```bash
cp .env.example .env    # fill in what you have
docker compose up -d
```

Collects every 5 minutes (`INTERVAL_MINUTES`), serves the dashboard at
`http://localhost:8087`. Data lives in `./data` on the host, so rebuilding the
image loses nothing.

### Option C: your own machine, no Docker

```bash
npm run watch           # collects every 5 minutes until you close it
```

Or add a cron entry:

```
*/5 * * * * cd /path/to/tracker && /usr/bin/node src/collect.mjs && /usr/bin/node src/build.mjs
```

This only collects while the machine is awake. Gaps in the chart are gaps in
your data, and you cannot backfill them - Roblox does not serve historical
concurrent player counts to anyone. That is the one real argument for Option A.

---

## Endpoint status

Verified against your live game on 27 August 2026:

| Endpoint | Result |
|---|---|
| universe id lookup | works |
| game details (players, visits, favourites) | works |
| votes | works |
| public server list | works |
| badges | works, returns an empty list because the game has none yet |
| game passes | 404 on every known public URL, handled gracefully |

---

## What it tracks

### Public, no key needed

| Metric | Source |
|---|---|
| Concurrent players, live | `games.roblox.com/v1/games` |
| Total visits, and growth per hour, day, week | same |
| Likes, dislikes, rating percent, rating trend | `/votes` |
| Favourites, and favourites as a share of visits | `/favorites/count` |
| Every public server: players, capacity, fill, ping, FPS | `/servers/Public` |
| Badge awards, all time and past day, win rate per badge | `badges.roblox.com` |
| Game passes and prices, with your 70% share worked out | see note below |
| Icon, creator, creation date, server size, genre | `games` and `thumbnails` |
| Rival games, same metrics, side by side | same endpoints |

Derived on top of that: all time peak players and when it happened, best day for
visits, average server fill, uptime, visits per hour, favourites per visit,
votes per visit, and a badge progression funnel that tells you what share of
players reach each milestone. Badges are the cheapest retention data on the
platform - one badge for joining, one for the first rebirth, one for 30 minutes
played, and you have a funnel for free.

**Note on game passes.** As of August 2026 every unauthenticated game pass
endpoint Roblox used to expose returns 404, verified against a large live game
as well as yours. The collector tries three known URLs and returns an empty list
rather than failing, so the rest of the dashboard is unaffected. If you find a
working URL, add it to the `candidates` array in `src/lib/roblox.mjs`. Revenue
still comes through properly via the Open Cloud key below.

### With an Open Cloud API key

Daily revenue in Robux, daily and monthly active users, D1/D7/D30 retention,
average session length, new against returning players, paying user conversion,
plus country and platform breakdowns.

To create the key:

1. https://create.roblox.com/dashboard/credentials -> Create API Key
2. Add API System: **universe-analytics**
3. Add the experience you want, and tick **universe.analytics:read**
4. Under Security, set the IP allowlist to `0.0.0.0/0` (or your server's IP).
   Leaving this empty is the single most common reason for a 403.
5. Copy the key into `.env` as `ROBLOX_API_KEY`, or into a GitHub secret.

Then `npm run doctor` and it will list which metrics your experience actually
serves. The API is in beta and metric names vary by product area, so the
tracker probes the list in `config.json` and quietly keeps whatever answers.
Metric names that come back as invalid are reported, not fatal. Add or remove
names in `openCloud.metrics` freely.

### Ads

Roblox has no public API for Ads Manager, so this part is a manual export:
Ads Manager -> Manage ads -> **Download**, then drop the CSV into `ads-drop/`.
The parser is tolerant of Roblox changing column names and handles their
formatting (`"40.90 USD"`, `"388,512"`, `"2.99%"`, `"248 hrs"`, an em dash for
empty). Keep dropping exports in; the newest file wins on a collision.

Once ad data and revenue are both present you get the numbers that actually
matter: cost per play, cost per hour of playtime, return on ad spend, net
position, and a break even cost per play so you know whether to raise or cut
your bid.

### Alerts

Set `DISCORD_WEBHOOK_URL` and you get pinged on a new all time peak, a sharp
drop or spike in players, the game going to zero servers, the rating falling
below your floor or dropping fast, visit milestones, revenue milestones, ad
spend milestones, and a daily summary. Thresholds are in `config.json` under
`alerts.rules`. Every alert fires once, tracked in `data/alert-state.json`.

```bash
npm run test-alert      # sends a test message
```

---

## Files

```
config.json              everything you tune
src/collect.mjs          one polling cycle
src/doctor.mjs           endpoint self test - run this when something breaks
src/build.mjs            renders dist/dashboard.html and docs/
src/loop.mjs             the forever loop for Docker and local use
src/demo.mjs             sample data generator
src/lib/roblox.mjs       public API client
src/lib/opencloud.mjs    Open Cloud analytics client
src/lib/ads.mjs          Ads Manager CSV parser
src/lib/derive.mjs       every computed metric
src/lib/alerts.mjs       Discord
src/lib/store.mjs        CSV and JSON persistence
site/index.html          the dashboard, one self contained file
data/timeseries.csv      append only history, one row per poll
ads-drop/                your Ads Manager exports
docs/                    what GitHub Pages serves
```

`data/timeseries.csv` is deliberately CSV. It diffs cleanly in git, so each
Actions run adds a line rather than rewriting a blob. Rows older than 14 days
are thinned to one per hour automatically once the file passes 5,000 rows.

---

## Troubleshooting

**Everything fails with `fetch failed`.** Your network blocks Roblox. Set
`"proxyHost": "roproxy.com"` in `config.json` under `collect` and every request
is rewritten to the community mirror. GitHub Actions runners do not need this.

**Open Cloud returns 403.** Nine times out of ten the API key has no IP
allowlist entry, or the key is not attached to that specific experience. Both
are on the key's edit page.

**A metric says "not a valid metric name".** That metric is not available for
your experience, or Roblox renamed it. Harmless. Remove it from
`openCloud.metrics` to quieten the log.

**The player chart has gaps.** The collector did not run. On Actions, check the
Actions tab for skipped or failed runs; on your own machine, the box was asleep.

**Ad columns are missing.** Send the CSV over, or look at the campaign's `extra`
object in `data/latest.json` - unmapped columns are kept there rather than
dropped, and the mapping in `src/lib/ads.mjs` takes 30 seconds to extend.

---

## Adding more games

`config.json` -> `competitors` takes any number of place ids. Each gets its own
panel on the benchmark section with its own scale, so a game a hundred times
your size does not flatten your line into the axis.

```json
"competitors": [
  { "name": "Rival tycoon", "placeId": 130228063094790 }
]
```
