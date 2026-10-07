# market-scout

A copy of moto-scout's Facebook Marketplace engine with the motorcycle-specific
parts removed, so it can search for **anything**. Everything about *what* to
look for lives in one file: [`search.json`](search.json).

## Change what it searches for

Edit `search.json`, then restart the helper (`node src/server.js`). That's it.

| Field | What it does |
|---|---|
| `profileName` | Prefix for the Google Sheet tabs (`Cars Matches`, `Cars All Listings`, ...). Change it when you change products so results don't mix. |
| `queries` | One Facebook search per entry, per city. Keep it to ~6; each costs ~25 s per city. Search is fuzzy, so broad terms are fine. |
| `minPrice` / `maxPrice` | Sent to Facebook *and* re-checked on every listing. |
| `cities` / `radiusMiles` | Where the searches are centred. Two cities at 100 mi covers a 100 mi circle around home; more is mostly overlap. |
| `maxDistanceMiles` | Listings further than this from home are rejected (from the city on the card, before the listing is even opened). |
| `mustContainAny` | Title or description must contain at least one of these to be a **Match**. Empty list = accept everything the searches return. |
| `mustNotContain` | Any hit anywhere rejects the listing (salvage, parts, down-payment ads, rentals...). |
| `minYear` | `null` to ignore. Years 1950+ are recognised. |
| `requireKeywordOnCard` | `true` (default): a search result is only opened if its card contains a `mustContainAny` word (or the search term, when that list is empty). Facebook search is fuzzy -- a "corvette" search returned motorcycles, and "bmw m340i" returned every BMW. |
| `home` | `{lat, lon, label}` to override `HOME_*` in `.env`. |

Each listing ends up as **Match**, **Needs Review** (price/distance unknown, or
no `mustContainAny` word found), or **Rejected** -- with the reason written next
to it in the sheet.

## Run it

```bash
cp .env.example .env     # set SCOUT_API_KEY, SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON
npm install
node src/selfcheck.js    # must say "All clear."
node src/server.js       # helper on http://127.0.0.1:8478
```

Opera must be running from `~/Applications/Opera.app` (launched with
`--remote-debugging-port=9222`) and logged into Facebook. The helper uses its
own background tab and never steals focus.

Same endpoints as moto-scout: `GET /health`, `POST /run`, `POST /check-removed`,
`POST /sheets/sync` -- all except `/health` need the `X-Scout-Key` header.

## n8n

Import [`n8n/market-scout.workflow.json`](n8n/market-scout.workflow.json). It is
the moto-scout workflow pointed at port 8478. Credentials do **not** travel with
an import: create a Header Auth credential (`X-Scout-Key`) and attach it to the
four HTTP Request nodes by hand.

Running both scouts on the same hourly schedule means both drive Opera at once.
Offset one of them (e.g. minute 30) in its Schedule node.

## Running next to moto-scout

Separate port (8478), separate database (`data/scout.db` in this folder),
separate browser tab (tagged `__marketScoutTab`), separate sheet tabs. They can
share the same spreadsheet and the same service-account key.
