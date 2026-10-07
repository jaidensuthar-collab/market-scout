'use strict';
/**
 * Raw Marketplace text -> structured fields. Every field carries a confidence
 * ('stated' | 'inferred' | 'unknown') so an inferred value is never mistaken
 * for something the seller actually wrote.
 *
 * Product-agnostic on purpose: no model names, no mileage, no title status.
 * Those belong to moto-scout. This keeps title, price, year, location,
 * distance, listed age, seller -- the fields any Marketplace listing has.
 */
const CURRENT_YEAR = new Date().getFullYear();

function field(value, confidence, source) {
  return { value, confidence, source: source || null };
}

function listingId(url) {
  const m = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

/** Card text often shows "$2,800 | $3,500" (live price first, old price second). */
function parsePrice(text) {
  if (!text) return field(null, 'unknown');
  const all = [...String(text).matchAll(/\$\s?([\d][\d,]{1,8})/g)].map(m => Number(m[1].replace(/,/g, '')));
  const sane = all.filter(n => n >= 50 && n <= 500000);
  if (!sane.length) return field(null, 'unknown');
  return field(sane[0], 'stated', 'listing');
}

/**
 * 1950+ with DIGIT boundaries, not word boundaries. moto-scout's version only
 * knew 1980+ (no older bikes exist in its searches), so for cars a "1978
 * Corvette" or "1965 Mustang" parsed as no-year and sailed past minYear. And
 * Facebook's notification-styled cards print "Unread2007 Chevrolet..." -- a
 * \b can't sit between the "d" and the "2", so that year was invisible too.
 */
function parseYear(text) {
  if (!text) return field(null, 'unknown');
  const hits = [...String(text).matchAll(/(?<![0-9])(19[5-9]\d|20[0-4]\d)(?![0-9])/g)]
    .map(m => Number(m[1]))
    .filter(y => y >= 1950 && y <= CURRENT_YEAR + 1);
  return hits.length ? field(hits[0], 'stated', 'listing') : field(null, 'unknown');
}

/** "... | San Antonio, TX" */
function parseLocation(text) {
  if (!text) return field(null, 'unknown');
  const m = String(text).match(/([A-Z][A-Za-z .'\-]{2,30}),\s*(TX|Texas|OK|LA|NM|AR)\b/);
  if (!m) return field(null, 'unknown');
  return field(`${m[1].trim()}, ${m[2] === 'Texas' ? 'TX' : m[2]}`, 'stated', 'listing');
}

/** Marketplace's own "· 42 mi". Anything preceded by "Within" is the search radius, not a distance. */
function parseMarketplaceDistance(text) {
  if (!text) return field(null, 'unknown');
  const s = String(text);
  for (const m of s.matchAll(/·\s*(\d{1,3})\s*mi\b/gi)) {
    if (/within\s*$/i.test(s.slice(Math.max(0, m.index - 20), m.index))) continue;
    return field(Number(m[1]), 'stated', 'marketplace');
  }
  const away = s.match(/\b(\d{1,3})\s*miles?\s+away\b/i);
  return away ? field(Number(away[1]), 'stated', 'marketplace') : field(null, 'unknown');
}

/** "Listed 7 weeks ago in ..." -> YYYY-MM-DD */
function parseListedAge(text) {
  if (!text) return field(null, 'unknown');
  const m = String(text).match(/Listed\s+(?:about\s+)?(a|an|\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return field(null, 'unknown');
  const n = /^(a|an)$/i.test(m[1]) ? 1 : Number(m[1]);
  const unitDays = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
  const d = new Date(Date.now() - Math.round(n * unitDays) * 86400000);
  return field(d.toISOString().slice(0, 10), 'inferred', `"${m[0]}"`);
}

function parseSeller(sellerText, descText) {
  const blob = `${sellerText || ''}\n${descText || ''}`;
  const nm = String(sellerText || '').match(/Seller information\s*\n?\s*(?:Seller details\s*\n?\s*)?([A-Z][A-Za-z .'\-]{1,40})/);
  const isDealer = /\b(dealer|dealership|inc\.?|llc|financing available|apply today|out the door|doc fee|we finance|trade-?ins? welcome)\b/i.test(blob);
  return {
    name: nm ? field(nm[1].trim(), 'stated', 'listing') : field(null, 'unknown'),
    type: field(isDealer ? 'Dealer' : 'Private', 'inferred', isDealer ? 'dealer keywords in listing' : 'no dealer keywords found'),
  };
}

/**
 * Build a normalised listing from a search card plus the opened detail page.
 *
 * Only LISTING-SCOPED text is used for the title/keywords: the page title,
 * the card, and the description. `head` is deliberately not consulted for
 * anything but listed-age -- it holds Facebook's nav and the search box still
 * containing the query that found the listing, which in moto-scout caused a
 * real listing to be stored under the wrong model.
 */
/**
 * Odometer reading. Deliberately strict, because Marketplace's own "· 42 mi"
 * distance badge has the same shape as a mileage figure: a number preceded by
 * the bullet is a distance, and a bare number under 1000 only counts as
 * mileage when "miles" is spelled out ("172 Miles" is real, "42 mi" is not).
 */
function parseMileage(text) {
  if (!text) return field(null, 'unknown');
  const s = String(text);
  const re = /(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(k)?\s*(miles|mile|mi)\b/gi;
  for (const m of s.matchAll(re)) {
    let n = Number(String(m[1]).replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (m[2]) n *= 1000;
    // "miles" spelled out is always an odometer, even right after the bullet
    // ("Macan S \u00b7 58,000 miles"). A bare "mi" is Marketplace's distance
    // badge unless it carries a k suffix or is too big to be a distance.
    if (!/mile/i.test(m[3])) {
      if (s.slice(Math.max(0, m.index - 3), m.index).includes('\u00b7')) continue;
      if (!m[2] && n < 1000) continue;
    }
    if (n < 100 || n > 400000) continue;
    return field(Math.round(n), 'stated', 'listing');
  }
  return field(null, 'unknown');
}

function normalize(card, detail) {
  const url = card.url || detail?.url;
  const cardText = card.raw || '';
  const head = detail?.head || '';
  const desc = detail?.desc || '';
  const aboutVehicle = detail?.aboutVehicle || '';

  const pageTitle = String(detail?.title || '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*\|\s*Facebook\s*$/i, '')
    .replace(/^\s*Marketplace\s*-\s*/i, '')
    .trim();
  // Card text is "$price | title | city"; the middle piece is the title.
  const cardTitle = (cardText.split('|')[1] || '').trim();
  const title = pageTitle || cardTitle || '';

  return {
    listingId: listingId(url),
    url,
    title,
    rawCardText: cardText,
    description: desc || null,
    aboutVehicle: aboutVehicle || null,
    year: parseYear(title || cardText),
    mileage: parseMileage(`${title}\n${desc}\n${aboutVehicle}`),
    price: parsePrice(cardText || head),
    location: parseLocation(cardText || head),
    marketplaceDistance: parseMarketplaceDistance(`${head}\n${cardText}`),
    datePosted: parseListedAge(head || desc),
    seller: parseSeller(detail?.seller || '', desc),
    images: detail?.images || (card.thumb ? [card.thumb] : []),
  };
}

module.exports = { field, listingId, parsePrice, parseYear, parseMileage, parseLocation, parseMarketplaceDistance, parseListedAge, parseSeller, normalize };
