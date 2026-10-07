'use strict';
/**
 * Staged pipeline, same shape as moto-scout's:
 *   Stage 1  scrape search cards                     ~free
 *   Stage 2  cheap gate on price/keywords/distance   ~free, kills most cards
 *   Stage 3  open the survivors                      one page load each
 *   Stage 4  classify + store
 * Everything product-specific comes from search.json via cfg.search.
 */
const cfg = require('./config');
const mp = require('./marketplace');
const parse = require('./parse');
const geo = require('./geo');
const db = require('./db');

const S = cfg.search;
const lc = s => String(s || '').toLowerCase();
const hasAny = (text, words) => words.some(w => lc(text).includes(w));

/** STAGE 2 -- cheap gate on the search card alone. Permissive on purpose. */
function cheapGate(card, query) {
  const t = card.raw || '';
  if (/partner listing|\bsponsored\b/i.test(t)) return { pass: false, why: 'sponsored/partner listing' };
  if (hasAny(t, S.mustNotContain)) return { pass: false, why: 'contains an excluded word' };

  // Facebook search is fuzzy: a "corvette" search returned a Yamaha and a
  // Kawasaki, and each would have cost one of the 25 listing-opens before
  // being thrown out. Require the card to mention the search term itself or
  // one of the mustContainAny words. search.json "requireKeywordOnCard": false
  // turns this off if a product's cards are too terse to name the thing.
  // mustContainAny takes precedence when set. Falling back to the query's
  // words as well sounded safer, but with cars every query carries a brand
  // word ("bmw m340i"), so "bmw" alone let a 328i, a 340i and an M550i
  // through and all three of a run's opens went to cars that were never
  // wanted. The user listed exactly what they want; trust that list.
  if (S.requireKeywordOnCard) {
    const words = S.mustContainAny.length ? S.mustContainAny
      : String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length && !hasAny(t, words)) {
      return { pass: false, why: S.mustContainAny.length ? 'card has none of the mustContainAny words' : 'card does not mention the search term' };
    }
  }

  const price = parse.parsePrice(t).value;
  if (price != null && S.maxPrice != null && price > S.maxPrice) return { pass: false, why: `price $${price} over max` };
  if (price != null && S.minPrice != null && price < S.minPrice) return { pass: false, why: `price $${price} under min` };

  const year = parse.parseYear(t).value;
  if (year != null && S.minYear != null && year < S.minYear) return { pass: false, why: `year ${year} under minYear` };

  // Distance from the city on the card. Facebook's radius filter sometimes
  // returns statewide results; rejecting here keeps the open budget for
  // listings actually in range. Unknown city => let it through.
  const cityDist = geo.distanceFor({ location: { value: parse.parseLocation(t).value }, marketplaceDistance: { value: null } }).used;
  if (cityDist != null && cityDist > S.maxDistanceMiles) return { pass: false, why: `${cityDist} mi away by city, over ${S.maxDistanceMiles} mi` };

  return { pass: true, price, year };
}

/** STAGE 4 -- decide what a fully-read listing is. */
function classify(listing, distance) {
  const text = `${listing.title}\n${listing.description || ''}\n${listing.aboutVehicle || ''}`;
  const p = listing.price.value, y = listing.year.value, d = distance.used;
  const mi = listing.mileage ? listing.mileage.value : null;
  const fail = [], miss = [];

  if (hasAny(text, S.mustNotContain)) fail.push('contains an excluded word');
  if (d != null && d > S.maxDistanceMiles) fail.push(`${d} mi exceeds ${S.maxDistanceMiles} mi limit`);
  if (p != null && S.maxPrice != null && p > S.maxPrice) fail.push(`Price $${p} exceeds $${S.maxPrice}`);
  if (p != null && S.minPrice != null && p < S.minPrice) fail.push(`Price $${p} below $${S.minPrice}`);
  if (y != null && S.minYear != null && y < S.minYear) fail.push(`Year ${y} older than ${S.minYear}`);
  if (mi != null && S.maxMileage != null && mi > S.maxMileage) fail.push(`Mileage ${mi.toLocaleString()} over ${S.maxMileage.toLocaleString()}`);
  if (fail.length) return { type: 'Rejected', reasons: fail };

  if (p == null) miss.push('price');
  if (d == null) miss.push('distance');
  if (S.maxMileage != null && mi == null) miss.push('mileage');
  if (S.mustContainAny.length && !hasAny(text, S.mustContainAny)) miss.push('none of the mustContainAny words appear');
  if (miss.length) return { type: 'Needs Review', reasons: [`Cannot confirm: ${miss.join(', ')}`] };

  return { type: 'Match', reasons: [`$${p}${mi != null ? ', ' + mi.toLocaleString() + ' mi' : ''}, ${d} mi away`] };
}

function toRecord(listing, distance, match) {
  return {
    listingId: listing.listingId, url: listing.url, title: listing.title,
    year: listing.year.value, price: listing.price.value,
    mileage: listing.mileage ? listing.mileage.value : null,
    city: listing.location.value ? String(listing.location.value).split(',')[0] : null,
    location: listing.location.value,
    marketplaceDistance: distance.marketplace, calculatedDistance: distance.calculated, distanceUsed: distance.used,
    sellerName: listing.seller.name.value, sellerType: listing.seller.type.value,
    datePosted: listing.datePosted.value, description: listing.description, images: listing.images,
    matchType: match.type, reasons: match.reasons, status: 'Active',
    notes: [match.reasons.join('; '), distance.note].filter(Boolean).join(' | '),
  };
}

async function runSweep({ limit } = {}) {
  const stats = { scanned: 0, opened: 0, rejected: 0, matches: 0, needsReview: 0, newListings: 0, updated: 0, priceChanges: 0, removed: 0, errors: [] };
  const runId = db.startRun();
  const maxOpen = limit || cfg.maxListingsPerRun;
  const records = [];
  const deadline = Date.now() + cfg.maxSweepMinutes * 60000;

  let page;
  try { page = await mp.getPage(); }
  catch (e) {
    stats.errors.push({ stage: 'browser', error: String(e.message) });
    db.finishRun(runId, stats);
    return { stats, records, fatal: 'Could not attach to the browser. Is Opera running with --remote-debugging-port=9222?' };
  }

  try {
    // Newest-first on even hours, relevance on odd: Facebook caps a search at
    // ~66 cards, so this is how both fresh postings and older never-seen ones
    // get a turn without doubling the search count.
    const sortForThisRun =
      cfg.searchSort === 'newest' ? 'creation_time_descend' :
      cfg.searchSort === 'relevance' ? undefined :
      (new Date().getHours() % 2 === 0 ? 'creation_time_descend' : undefined);
    stats.searchSort = sortForThisRun || 'relevance';

    const candidates = new Map();
    let consecutiveFailures = 0;
    outer:
    for (const city of S.cities) {
      for (const query of S.queries) {
        if (Date.now() >= deadline) { stats.errors.push({ stage: 'search', error: `sweep deadline (${cfg.maxSweepMinutes} min) reached` }); break outer; }
        if (consecutiveFailures >= cfg.maxConsecutiveFailures) { stats.errors.push({ stage: 'search', error: 'too many consecutive failures, aborting run' }); break outer; }
        try {
          const res = await mp.search(page, { city, query, maxPrice: S.maxPrice, minPrice: S.minPrice, radius: S.radiusMiles, sortBy: sortForThisRun });
          if (res.blocked) { stats.errors.push({ stage: 'search', city, query, error: `blocked: ${res.reason}` }); break outer; }
          stats.scanned += res.cards.length;
          consecutiveFailures = 0;
          for (const card of res.cards) {
            const gate = cheapGate(card, query);
            if (!gate.pass) { stats.rejected++; continue; }
            const id = parse.listingId(card.url);
            if (id && !candidates.has(id)) candidates.set(id, card);
          }
        } catch (e) {
          consecutiveFailures++;
          stats.errors.push({ stage: 'search', city, query, error: String(e.message).slice(0, 160) });
        }
        await mp.politeDelay(cfg.delays.betweenSearches);
      }
    }

    // Never-seen first, then known ones oldest-check first.
    const ordered = [...candidates.entries()].sort((A, B) => {
      const a = db.getListing(A[0]), b = db.getListing(B[0]);
      if (!a && b) return -1;
      if (a && !b) return 1;
      if (!a && !b) return 0;
      return String(a.last_checked || '').localeCompare(String(b.last_checked || ''));
    });
    stats.candidates = ordered.length;
    stats.candidatesUnseen = ordered.filter(([id]) => !db.getListing(id)).length;
    stats.openBudget = maxOpen;

    let opened = 0;
    for (const [id, card] of ordered) {
      if (opened >= maxOpen) break;
      if (Date.now() >= deadline) { stats.errors.push({ stage: 'listing', error: `sweep deadline reached, ${ordered.length - opened} candidate(s) left for next run` }); break; }
      try {
        const detail = await mp.openListing(page, card.url);
        if (detail.blocked) { stats.errors.push({ stage: 'listing', id, error: `blocked: ${detail.reason}` }); break; }
        if (detail.gone) {
          if (db.getListing(id)) { db.markRemoved(id, 'Removed'); stats.removed++; }
        } else {
          opened++; stats.opened++;
          const listing = parse.normalize(card, detail);
          const distance = geo.distanceFor(listing);
          const match = classify(listing, distance);
          const rec = toRecord(listing, distance, match);
          const { isNew, priceChanged } = db.upsertListing(rec);
          if (isNew) stats.newListings++; else stats.updated++;
          if (priceChanged) stats.priceChanges++;
          if (match.type === 'Match') stats.matches++;
          else if (match.type === 'Needs Review') stats.needsReview++;
          else stats.rejected++;
          records.push(rec);
        }
      } catch (e) {
        stats.errors.push({ stage: 'listing', id, error: String(e.message).slice(0, 160) });
      }
      await mp.politeDelay(cfg.delays.betweenListings);
    }
    return { stats, records, runId };
  } finally {
    db.finishRun(runId, stats);
    try { page.close(); } catch {}
  }
}

/** Re-check known listings and retire the dead ones. Rows are marked, never deleted. */
async function checkRemoved({ max = 15 } = {}) {
  const rows = db.activeIds().slice(0, max);
  const out = { checked: 0, removed: 0, errors: [] };
  if (!rows.length) return out;
  let page;
  try { page = await mp.getPage(); } catch (e) { out.errors.push(String(e.message)); return out; }
  for (const r of rows) {
    try {
      const d = await mp.openListing(page, r.url);
      out.checked++;
      if (d.blocked) { out.errors.push(`blocked: ${d.reason}`); break; }
      const body = `${d.head || ''} ${d.desc || ''} ${d.title || ''}`;
      const gone = d.gone || /this content isn'?t available|page not found|no longer available|content unavailable/i.test(body);
      const sold = /\bsold\b/i.test(d.head || '') || /marked as sold/i.test(body);
      if (gone) { db.markRemoved(r.listing_id, 'Removed'); out.removed++; }
      else if (sold) { db.markRemoved(r.listing_id, 'Sold'); out.removed++; }
      else db.touchChecked(r.listing_id);
    } catch (e) { out.errors.push(String(e.message).slice(0, 120)); }
    await mp.politeDelay(cfg.delays.betweenListings);
  }
  try { page.close(); } catch {}
  return out;
}

module.exports = { runSweep, checkRemoved, cheapGate, classify, toRecord };
