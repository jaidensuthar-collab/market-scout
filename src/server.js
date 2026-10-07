'use strict';
/**
 * Local helper API. n8n calls this over HTTP; the browser connection and
 * SQLite handle stay warm between runs. Protected by a shared-secret header.
 * Same endpoints as moto-scout, different port, so both can run side by side.
 */
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const pipeline = require('./pipeline');
const sheets = require('./sheets');
const mp = require('./marketplace');
const parse = require('./parse');
const { browserVersion, listTargets } = require('./cdp');

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!cfg.apiKey) return res.status(500).json({ error: 'SCOUT_API_KEY is not set in .env' });
  if (req.get('X-Scout-Key') !== cfg.apiKey) return res.status(401).json({ error: 'bad or missing X-Scout-Key' });
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e =>
  res.status(500).json({ error: String(e.message).slice(0, 400), stack: cfg.testMode ? e.stack : undefined }));

app.get('/health', wrap(async (_req, res) => {
  let browser = null, tabs = null;
  try { browser = (await browserVersion(cfg.cdpUrl)).Browser; tabs = (await listTargets(cfg.cdpUrl)).length; }
  catch (e) { browser = `UNREACHABLE: ${e.message}`; }
  res.json({
    ok: true, testMode: cfg.testMode, browser, tabs, sheetConfigured: !!cfg.sheetId,
    profile: cfg.search.profileName, queries: cfg.search.queries,
    price: { min: cfg.search.minPrice, max: cfg.search.maxPrice },
    cities: cfg.search.cities, radiusMiles: cfg.search.radiusMiles, maxDistanceMiles: cfg.search.maxDistanceMiles,
  });
}));

app.get('/facebook/status', wrap(async (_req, res) => {
  const page = await mp.getPage();
  try { const blk = await mp.detectBlock(page); res.json({ loggedIn: !blk.blocked, ...blk, url: await page.eval('(()=>location.href)()', 5000) }); }
  finally { page.close(); }
}));

app.post('/search', wrap(async (req, res) => {
  const { city = cfg.search.cities[0], query = cfg.search.queries[0], radius = cfg.search.radiusMiles } = req.body || {};
  const page = await mp.getPage();
  try {
    const r = await mp.search(page, { city, query, radius, maxPrice: cfg.search.maxPrice, minPrice: cfg.search.minPrice });
    res.json({ ...r, cardCount: r.cards.length, gate: r.cards.slice(0, 40).map(c => ({ raw: c.raw, ...pipeline.cheapGate(c, query) })) });
  } finally { page.close(); }
}));

app.post('/listing', wrap(async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  const page = await mp.getPage();
  try { res.json(await mp.openListing(page, url)); } finally { page.close(); }
}));

/** THE MAIN ENTRY POINT. n8n's schedule calls this. */
app.post('/run', wrap(async (req, res) => res.json(await pipeline.runSweep({ limit: req.body?.limit }))));
app.post('/check-removed', wrap(async (req, res) => res.json(await pipeline.checkRemoved({ max: req.body?.max || 15 }))));
app.post('/sheets/sync', wrap(async (_req, res) => res.json(await sheets.syncAll())));
app.post('/sheets/init', wrap(async (_req, res) => res.json(await sheets.ensureTabs(await sheets.client()))));

app.get('/listings', wrap(async (req, res) => {
  const all = db.allListings();
  const t = req.query.match;
  res.json({ count: all.length, listings: t ? all.filter(r => r.match_type === t) : all });
}));
app.get('/listings/:id', wrap(async (req, res) => {
  const r = db.getListing(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ ...r, priceHistory: db.priceHistory(req.params.id) });
}));
app.get('/runs', wrap(async (_req, res) => res.json(db.recentRuns(50))));

/** Deliberately not implemented: contacting sellers must never be automatic. */
app.post('/message-seller', (_req, res) => res.status(501).json({ error: 'not implemented by design' }));

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`market-scout helper listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  profile="${cfg.search.profileName}"  queries=${cfg.search.queries.length}  cities=${cfg.search.cities.join(',')}  TEST_MODE=${cfg.testMode}`);
  if (!cfg.apiKey) console.warn('  WARNING: SCOUT_API_KEY is empty. Set it in .env before using with n8n.');
});
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
module.exports = app;
