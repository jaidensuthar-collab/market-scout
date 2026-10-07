'use strict';
/**
 * Config loader: .env for machine/service settings, search.json for WHAT to
 * search for. The split is deliberate -- search.json is the file you edit to
 * point this at a different product, and it holds nothing secret, so it is
 * safe to copy around or share.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile();

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

/** The user-edited search profile. Validated loudly: a typo here should fail at startup, not mid-sweep. */
function loadSearchProfile() {
  const p = path.join(ROOT, process.env.SEARCH_FILE || 'search.json');
  if (!fs.existsSync(p)) throw new Error(`search profile not found at ${p}`);
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`search.json is not valid JSON: ${e.message}`); }

  const lower = a => (Array.isArray(a) ? a : []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const out = {
    profileName: String(s.profileName || 'Search').trim(),
    queries: lower(s.queries),
    minPrice: s.minPrice == null ? null : Number(s.minPrice),
    maxPrice: s.maxPrice == null ? null : Number(s.maxPrice),
    cities: lower(s.cities).length ? lower(s.cities) : ['austin'],
    radiusMiles: num(s.radiusMiles, 100),
    maxDistanceMiles: num(s.maxDistanceMiles, 100),
    mustContainAny: lower(s.mustContainAny),
    mustNotContain: lower(s.mustNotContain),
    minYear: s.minYear == null ? null : Number(s.minYear),
    maxMileage: s.maxMileage == null ? null : Number(s.maxMileage),
    requireKeywordOnCard: s.requireKeywordOnCard !== false,
    home: s.home && s.home.lat != null && s.home.lon != null
      ? { lat: Number(s.home.lat), lon: Number(s.home.lon), label: s.home.label || 'home' }
      : null,
  };
  if (!out.queries.length) throw new Error('search.json: "queries" must list at least one search term');
  if (out.maxMileage != null && !(out.maxMileage > 0)) {
    throw new Error('search.json: maxMileage must be a positive number, or null to ignore mileage');
  }
  if (out.maxPrice != null && out.minPrice != null && out.maxPrice < out.minPrice) {
    throw new Error('search.json: maxPrice is below minPrice');
  }
  return out;
}

const search = loadSearchProfile();

const cfg = {
  root: ROOT,
  port: num(process.env.PORT, 8478),
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.SCOUT_API_KEY || '',

  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',

  home: search.home || {
    lat: num(process.env.HOME_LAT, 30.3799),
    lon: num(process.env.HOME_LON, -97.9028),
    label: process.env.HOME_LABEL || 'home',
  },

  search,
  // marketplace.js (shared with moto-scout) reads these names directly.
  cities: search.cities,
  searchRadiusMiles: search.radiusMiles,
  searchMaxPrice: search.maxPrice,
  searchMinPrice: search.minPrice,
  searchSort: (process.env.SEARCH_SORT || 'relevance').toLowerCase(),

  delays: {
    betweenSearches: num(process.env.DELAY_BETWEEN_SEARCHES_MS, 9000),
    betweenListings: num(process.env.DELAY_BETWEEN_LISTINGS_MS, 6000),
    jitter: num(process.env.DELAY_JITTER_MS, 4000),
  },
  maxListingsPerRun: num(process.env.MAX_LISTINGS_PER_RUN, 25),
  maxConsecutiveFailures: num(process.env.MAX_CONSECUTIVE_FAILURES, 4),
  maxSweepMinutes: num(process.env.MAX_SWEEP_MINUTES, 22),

  sheetId: process.env.SHEET_ID || '',
  googleSaJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

  testMode: bool(process.env.TEST_MODE, true),
  enableFacebookSave: bool(process.env.ENABLE_FACEBOOK_SAVE, false),

  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/scout.db'),
  logPath: path.resolve(ROOT, process.env.LOG_PATH || './logs'),
};

/**
 * Marketplace URL parameters, learned against the live site in moto-scout:
 * `radius` is in KILOMETRES (129 -> "Within 80 mi", 161 -> "Within 100 mi"),
 * and sortBy=creation_time_descend is honoured (verified: same query, same
 * moment, different card order).
 */
cfg.url = {
  milesToKm: mi => Math.round(mi * 1.60934),
  search({ city = 'austin', query, maxPrice, minPrice, radiusMiles = 100, sortBy, daysSinceListed, exact = false } = {}) {
    const p = new URLSearchParams();
    if (query) p.set('query', query);
    if (minPrice != null) p.set('minPrice', String(minPrice));
    if (maxPrice != null) p.set('maxPrice', String(maxPrice));
    if (radiusMiles != null) p.set('radius', String(cfg.url.milesToKm(radiusMiles)));
    if (sortBy) p.set('sortBy', sortBy);
    if (daysSinceListed) p.set('daysSinceListed', String(daysSinceListed));
    if (exact) p.set('exact', 'true');
    return `https://www.facebook.com/marketplace/${city}/search?${p.toString()}`;
  },
};

module.exports = cfg;
