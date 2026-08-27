Drop your Roblox Ads Manager CSV exports in this folder.

How to get one:
  1. https://create.roblox.com/dashboard/ads  ->  Manage ads
  2. Pick your date range and experience
  3. Click Download (top right of the campaign table)
  4. Save the CSV here, keep the filename it came with

The tracker reads every CSV in this folder on each run and merges them, so you
can keep dropping new exports without deleting the old ones. If the same
campaign appears in two files, the newer file wins.

There is no public Roblox API for ad performance, which is why this is a manual
export rather than something the tracker can poll. Everything else on the
dashboard updates by itself.

If a column does not come through, the raw value is kept in the campaign's
"extra" object in data/latest.json - send that over and the mapping can be
extended in src/lib/ads.mjs.
