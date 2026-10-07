'use strict';
/**
 * Google Sheets as the VIEW layer. SQLite is the source of truth; every tab
 * here is rewritten from it on each sync. Tab names are prefixed with the
 * profile name from search.json so several profiles can share one
 * spreadsheet, and get a " _TEST" suffix in TEST_MODE.
 *
 * Writes are batched (one batchClear, one or two values.batchUpdate, one
 * formatting batchUpdate) -- unbatched per-tab writes tripped the Sheets
 * per-minute write quota in moto-scout.
 */
const fs = require('fs');
const cfg = require('./config');
const db = require('./db');

let google = null;
try { ({ google } = require('googleapis')); } catch { google = null; }

const TAB = { matches: 'Matches', all: 'All Listings', history: 'Price History', logs: 'Logs' };
function tabName(key) {
  const base = `${cfg.search.profileName} ${TAB[key]}`;
  return cfg.testMode ? `${base} _TEST` : base;
}

const MATCH_HEADERS = ['Match', 'Year', 'Title', 'Price', 'Mileage', 'Mi Away', 'City', 'Seller', 'Listed', 'First Found', 'Why', 'Link'];
const MATCH_WIDTHS  = [96, 50, 260, 72, 76, 62, 110, 110, 86, 86, 260, 60];
const ALL_HEADERS = ['Listing ID', 'URL', 'Title', 'Year', 'Price', 'Mileage', 'City', 'Location', 'Marketplace Distance',
  'Calculated Distance', 'Distance Used', 'Seller', 'Seller Type', 'Date Posted', 'Description', 'Match Type',
  'Reasons', 'First Found', 'Last Checked', 'Status', 'Notes'];
const HISTORY_HEADERS = ['Listing ID', 'Title', 'Old Price', 'New Price', 'Change', 'Percent', 'Changed At', 'URL'];
const LOG_HEADERS = ['Run Started', 'Run Finished', 'Test Mode', 'Scanned', 'Opened', 'Rejected', 'Matches',
  'Needs Review', 'New', 'Updated', 'Price Changes', 'Removed', 'Errors'];

const asList = v => { try { const p = JSON.parse(v); return Array.isArray(p) ? p.join('; ') : String(v ?? ''); } catch { return String(v ?? ''); } };

function matchRow(r) {
  return [
    r.match_type || '', r.year ?? '', r.title || '',
    r.price != null ? `$${r.price.toLocaleString()}` : '',
    r.mileage != null ? r.mileage.toLocaleString() : '',
    r.distance_used ?? '?', r.city || '', r.seller_name || '',
    // Leading apostrophe: this tab is written USER_ENTERED (for the HYPERLINK
    // column), and Sheets turns a bare "2026-10-06" into a date serial (46301).
    r.date_posted ? `'${r.date_posted}` : '', r.date_first_found ? `'${r.date_first_found.slice(0, 10)}` : '',
    asList(r.reasons),
    r.url ? `=HYPERLINK("${r.url}","open")` : '',
  ];
}

function allRow(r) {
  return [
    r.listing_id, r.url, r.title || '', r.year ?? '', r.price ?? '', r.mileage ?? '', r.city || '', r.location || '',
    r.marketplace_distance ?? '', r.calculated_distance ?? '', r.distance_used ?? '',
    r.seller_name || '', r.seller_type || '', r.date_posted || '', (r.description || '').slice(0, 1800),
    r.match_type || '', asList(r.reasons), (r.date_first_found || '').slice(0, 19), (r.last_checked || '').slice(0, 19),
    r.status || 'Active', r.notes || '',
  ];
}

async function client() {
  if (!google) throw new Error('googleapis not installed. Run: npm install');
  if (!cfg.sheetId) throw new Error('SHEET_ID is not set in .env');
  if (!cfg.googleSaJson || !fs.existsSync(cfg.googleSaJson)) throw new Error(`Service-account JSON not found at ${cfg.googleSaJson}`);
  const auth = new google.auth.GoogleAuth({ keyFile: cfg.googleSaJson, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function ensureTabs(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const have = new Set(meta.data.sheets.map(s => s.properties.title));
  const missing = Object.keys(TAB).map(tabName).filter(t => !have.has(t));
  if (!missing.length) return { created: [] };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.sheetId,
    requestBody: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
  });
  return { created: missing };
}

async function writeTabsBatched(sheets, tabs) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const sheetIdByTitle = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

  await sheets.spreadsheets.values.batchClear({ spreadsheetId: cfg.sheetId, requestBody: { ranges: tabs.map(t => `${t.title}!A1:ZZ100000`) } });
  const toData = list => list.map(t => ({ range: `${t.title}!A1`, values: [t.header, ...t.rows] }));
  const formulaTabs = tabs.filter(t => t.opts?.formulas), rawTabs = tabs.filter(t => !t.opts?.formulas);
  if (rawTabs.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { valueInputOption: 'RAW', data: toData(rawTabs) } });
  if (formulaTabs.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: toData(formulaTabs) } });

  const requests = [];
  for (const t of tabs) {
    const sheetId = sheetIdByTitle[t.title];
    if (sheetId == null) continue;
    (t.opts?.widths || []).forEach((px, i) => requests.push({
      updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' },
    }));
    requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.92, green: 0.93, blue: 0.95 } } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
    requests.push({ repeatCell: { range: { sheetId }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } });
  }
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.sheetId, requestBody: { requests } });
}

/** Rebuild every tab from SQLite. */
async function syncAll() {
  const sheets = await client();
  const created = await ensureTabs(sheets);
  const all = db.allListings();
  const history = db.open().prepare('SELECT * FROM price_history ORDER BY changed_at').all();
  const active = all.filter(r => r.status === 'Active');
  const byId = Object.fromEntries(all.map(r => [r.listing_id, r]));

  const RANK = { 'Match': 0, 'Needs Review': 1 };
  const shown = active.filter(r => RANK[r.match_type] !== undefined)
    .sort((a, b) => RANK[a.match_type] - RANK[b.match_type] || (a.distance_used ?? 999) - (b.distance_used ?? 999) || (a.price ?? 1e9) - (b.price ?? 1e9));

  await writeTabsBatched(sheets, [
    { title: tabName('matches'), header: MATCH_HEADERS, rows: shown.map(matchRow), opts: { widths: MATCH_WIDTHS, formulas: true } },
    { title: tabName('all'), header: ALL_HEADERS, rows: all.map(allRow), opts: {} },
    { title: tabName('history'), header: HISTORY_HEADERS, rows: history.map(p => [
        p.listing_id, byId[p.listing_id]?.title || '', p.old_price, p.new_price,
        `${p.delta > 0 ? '+' : ''}${p.delta}`, `${p.pct}%`, p.changed_at, byId[p.listing_id]?.url || '' ]), opts: {} },
    { title: tabName('logs'), header: LOG_HEADERS, rows: db.recentRuns(100).map(r => [
        r.started_at, r.finished_at, r.test_mode ? 'TEST' : 'LIVE', r.scanned, r.opened, r.rejected,
        r.matches, r.needs_review, r.new_listings, r.updated, r.price_changes, r.removed, (r.errors || '').slice(0, 900) ]), opts: {} },
  ]);

  return {
    ok: true, testMode: cfg.testMode, profile: cfg.search.profileName, createdTabs: created.created,
    counts: {
      all: all.length,
      matches: active.filter(r => r.match_type === 'Match').length,
      review: active.filter(r => r.match_type === 'Needs Review').length,
      removed: all.filter(r => r.status !== 'Active').length,
      history: history.length,
    },
  };
}

module.exports = { syncAll, ensureTabs, client, TAB, tabName, writeTabsBatched, MATCH_HEADERS, ALL_HEADERS, matchRow, allRow };
