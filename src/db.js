'use strict';
/**
 * Local SQLite store. SQLite is the source of truth; the Google Sheet is a
 * rendered view that can be rebuilt from it at any time.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

let db = null;

function open() {
  if (db) return db;
  if (!Database) throw new Error('better-sqlite3 not installed. Run: npm install');
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    listing_id        TEXT PRIMARY KEY,
    url               TEXT NOT NULL,
    title             TEXT,
    year              INTEGER,
    price             INTEGER,
    mileage           INTEGER,
    city              TEXT,
    location          TEXT,
    marketplace_distance INTEGER,
    calculated_distance  INTEGER,
    distance_used     INTEGER,
    seller_name       TEXT,
    seller_type       TEXT,
    date_posted       TEXT,
    description       TEXT,
    images            TEXT,
    match_type        TEXT,
    reasons           TEXT,
    date_first_found  TEXT,
    last_checked      TEXT,
    status            TEXT DEFAULT 'Active',
    notes             TEXT
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, listing_id TEXT NOT NULL,
    old_price INTEGER, new_price INTEGER, delta INTEGER, pct REAL, changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ph_listing ON price_history(listing_id);
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT, finished_at TEXT,
    scanned INTEGER DEFAULT 0, opened INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0,
    matches INTEGER DEFAULT 0, needs_review INTEGER DEFAULT 0,
    new_listings INTEGER DEFAULT 0, updated INTEGER DEFAULT 0,
    price_changes INTEGER DEFAULT 0, removed INTEGER DEFAULT 0,
    errors TEXT, test_mode INTEGER DEFAULT 1, notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_match ON listings(match_type);
  `);
  return db;
}

const J = v => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Insert or update. Records a price_history row when the price moves. */
function upsertListing(rec) {
  open();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT listing_id, price, date_first_found FROM listings WHERE listing_id=?').get(rec.listingId);

  let priceChanged = null;
  if (existing && rec.price != null && existing.price != null && existing.price !== rec.price) {
    const delta = rec.price - existing.price;
    const pct = existing.price ? Math.round((delta / existing.price) * 1000) / 10 : null;
    db.prepare(`INSERT INTO price_history (listing_id, old_price, new_price, delta, pct, changed_at) VALUES (?,?,?,?,?,?)`)
      .run(rec.listingId, existing.price, rec.price, delta, pct, now);
    priceChanged = { from: existing.price, to: rec.price, delta, pct };
  }

  const row = {
    listing_id: rec.listingId, url: rec.url, title: rec.title, year: rec.year, price: rec.price,
    mileage: rec.mileage,
    city: rec.city, location: rec.location,
    marketplace_distance: rec.marketplaceDistance, calculated_distance: rec.calculatedDistance, distance_used: rec.distanceUsed,
    seller_name: rec.sellerName, seller_type: rec.sellerType, date_posted: rec.datePosted,
    description: rec.description, images: J(rec.images),
    match_type: rec.matchType, reasons: J(rec.reasons),
    date_first_found: existing?.date_first_found || now,
    last_checked: now, status: rec.status || 'Active', notes: rec.notes,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})
     ON CONFLICT(listing_id) DO UPDATE SET ${cols.filter(c => c !== 'listing_id' && c !== 'date_first_found').map(c => `${c}=excluded.${c}`).join(',')}`
  ).run(row);
  return { isNew: !existing, priceChanged };
}

const getListing  = id => (open(), db.prepare('SELECT * FROM listings WHERE listing_id=?').get(id));
const allListings = () => (open(), db.prepare('SELECT * FROM listings ORDER BY date_first_found DESC').all());
// Oldest check first so checkRemoved() rotates through EVERY active listing
// over successive runs instead of re-checking the same first N forever.
const activeIds   = () => (open(), db.prepare(`SELECT listing_id,url FROM listings WHERE status='Active' ORDER BY last_checked ASC`).all());
const priceHistory = id => (open(), db.prepare('SELECT * FROM price_history WHERE listing_id=? ORDER BY changed_at').all(id));

/** Listing re-checked and still alive: bump last_checked so the oldest-first rotation moves on. */
function touchChecked(listingId) {
  open();
  db.prepare(`UPDATE listings SET last_checked=? WHERE listing_id=?`).run(new Date().toISOString(), listingId);
}

function markRemoved(listingId, status = 'Removed') {
  open();
  db.prepare(`UPDATE listings SET status=?, last_checked=? WHERE listing_id=?`).run(status, new Date().toISOString(), listingId);
}

function startRun() {
  open();
  return db.prepare(`INSERT INTO runs (started_at, test_mode) VALUES (?,?)`).run(new Date().toISOString(), cfg.testMode ? 1 : 0).lastInsertRowid;
}

function finishRun(id, stats) {
  open();
  db.prepare(`UPDATE runs SET finished_at=@finished_at, scanned=@scanned, opened=@opened, rejected=@rejected,
    matches=@matches, needs_review=@needs_review, new_listings=@new_listings, updated=@updated,
    price_changes=@price_changes, removed=@removed, errors=@errors, notes=@notes WHERE id=@id`).run({
      id, finished_at: new Date().toISOString(),
      scanned: stats.scanned | 0, opened: stats.opened | 0, rejected: stats.rejected | 0,
      matches: stats.matches | 0, needs_review: stats.needsReview | 0,
      new_listings: stats.newListings | 0, updated: stats.updated | 0,
      price_changes: stats.priceChanges | 0, removed: stats.removed | 0,
      errors: J(stats.errors || []), notes: stats.notes || null,
    });
}

const recentRuns = (n = 25) => (open(), db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(n));

module.exports = { open, upsertListing, getListing, allListings, activeIds, priceHistory, markRemoved, touchChecked, startRun, finishRun, recentRuns };
