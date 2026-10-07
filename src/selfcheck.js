'use strict';
/** One-command health check: node src/selfcheck.js */
const fs = require('fs');
const path = require('path');

const results = [];
const ok   = (n, d) => results.push({ n, s: 'OK', d });
const warn = (n, d) => results.push({ n, s: 'WARN', d });
const bad  = (n, d) => results.push({ n, s: 'FAIL', d });

(async () => {
  let cfg;
  try { cfg = require('./config'); ok('search.json', `profile "${cfg.search.profileName}", ${cfg.search.queries.length} queries, $${cfg.search.minPrice ?? 0}-$${cfg.search.maxPrice ?? '∞'}, ${cfg.search.cities.join('/')} @ ${cfg.search.radiusMiles} mi`); }
  catch (e) { bad('search.json', e.message); printAndExit(); return; }

  ok('Node', process.version);
  for (const dep of ['better-sqlite3', 'express', 'googleapis']) {
    try { require.resolve(dep); ok(`dep ${dep}`, 'installed'); } catch { bad(`dep ${dep}`, 'missing -- run npm install'); }
  }
  fs.existsSync(path.join(cfg.root, '.env')) ? ok('.env', 'present') : bad('.env', 'missing -- copy .env.example to .env');
  cfg.apiKey ? ok('SCOUT_API_KEY', `set (${cfg.apiKey.length} chars)`) : bad('SCOUT_API_KEY', 'empty');

  try {
    const { browserVersion, listTargets, openPage } = require('./cdp');
    const v = await browserVersion(cfg.cdpUrl);
    const t = await listTargets(cfg.cdpUrl);
    ok('Browser CDP', `${v.Browser} — ${t.length} tabs`);
    const p = await openPage(cfg.cdpUrl, u => u.includes('facebook.com'));
    if (p) {
      const txt = await p.eval('(()=>document.body?document.body.innerText.slice(0,2000):"")()', 5000).catch(() => '');
      p.close();
      /log in|log into facebook/i.test(txt) ? bad('Facebook session', 'looks logged out') : ok('Facebook session', 'appears logged in');
    } else warn('Facebook session', 'no Facebook tab open — the helper will open one');
  } catch (e) { bad('Browser CDP', `${e.message}. Launch Opera with --remote-debugging-port=9222`); }

  try { require('./db').open(); ok('SQLite', cfg.dbPath); } catch (e) { bad('SQLite', e.message); }

  if (!cfg.sheetId) warn('Google Sheets', 'SHEET_ID not set — Sheets sync will be skipped');
  else if (!cfg.googleSaJson || !fs.existsSync(cfg.googleSaJson)) bad('Google Sheets', `service-account JSON not found at ${cfg.googleSaJson}`);
  else {
    try {
      const s = await require('./sheets').client();
      const meta = await s.spreadsheets.get({ spreadsheetId: cfg.sheetId });
      ok('Google Sheets', `"${meta.data.properties.title}" reachable`);
    } catch (e) { bad('Google Sheets', `${String(e.message).slice(0, 150)} — shared with the service-account email as Editor?`); }
  }

  ok('TEST_MODE', String(cfg.testMode) + (cfg.testMode ? ' (writes to _TEST tabs)' : ' (LIVE)'));

  // Gate regression: price range, excluded words, card-level distance, unknown city passes.
  try {
    const { cheapGate } = require('./pipeline');
    const S = cfg.search;
    const okPrice = S.maxPrice != null ? Math.min(S.maxPrice, (S.minPrice || 0) + 1000) : 10000;
    const CASES = [
      [`$${okPrice} | 2020 ${S.queries[0]} | Round Rock, TX`, true, 'in range'],
      [`$${okPrice} | 2020 ${S.queries[0]} | Houston, TX`, false, 'too far by city'],
      [`$${okPrice} | 2020 ${S.queries[0]} | Nowheresville, TX`, true, 'unknown city passes'],
      ...(S.maxPrice != null ? [[`$${S.maxPrice + 5000} | 2020 ${S.queries[0]} | Austin, TX`, false, 'over max price']] : []),
      ...(S.mustNotContain.length ? [[`$${okPrice} | 2020 ${S.queries[0]} ${S.mustNotContain[0]} | Austin, TX`, false, 'excluded word']] : []),
    ];
    const failed = CASES.filter(([raw, want]) => cheapGate({ raw }).pass !== want);
    failed.length ? bad('Cheap gate', failed.map(f => f[2]).join('; ')) : ok('Cheap gate', `${CASES.length}/${CASES.length} cases pass`);
  } catch (e) { bad('Cheap gate', e.message); }

  // checkRemoved rotation needs BOTH halves: oldest-first ordering and bumping
  // last_checked on listings found still alive. Learned in moto-scout: with
  // only the ORDER BY, the same 15 were re-checked every hour (verified live).
  try {
    const src = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const rotates = /activeIds[\s\S]{0,200}ORDER BY last_checked ASC/.test(src('db.js')) && /else db\.touchChecked\(/.test(src('pipeline.js'));
    rotates ? ok('Removal rotation', 'oldest-first + touchChecked on alive listings') : bad('Removal rotation', 'same listings would be re-checked every run');
  } catch (e) { bad('Removal rotation', e.message); }

  printAndExit();
})();

function printAndExit() {
  const pad = Math.max(...results.map(r => r.n.length));
  console.log('\nmarket-scout self-check\n' + '─'.repeat(60));
  for (const r of results) console.log(`${r.s === 'OK' ? '✓' : r.s === 'WARN' ? '!' : '✗'} ${r.n.padEnd(pad)}  ${r.d}`);
  const fails = results.filter(r => r.s === 'FAIL').length;
  console.log('─'.repeat(60));
  console.log(fails ? `${fails} blocking problem(s).` : 'All clear.');
  process.exit(fails ? 1 : 0);
}
