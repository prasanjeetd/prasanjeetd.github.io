/* report.mjs — the full activity report, grouped by date then by visitor.
 *
 *   node tools/report.mjs                  everything
 *   node tools/report.mjs 2026-08-12       one date
 *   node tools/report.mjs today            shortcut
 *   node tools/report.mjs --errors         only sessions that hit a problem
 *   node tools/report.mjs --site other.com
 *
 * Driven by logs.bat, which is what you double-click.
 */
import { env, loadEvents, dedupe, listAll, human } from './r2.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const bare = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--site');

const ERRORS_ONLY = flag('--errors');
const SITE = val('--site');
let DATE = bare[0];
if (DATE === 'today') DATE = new Date().toISOString().slice(0, 10);
if (DATE === 'all') DATE = undefined;

// Anything here marks a session as having gone wrong, and is highlighted.
const BAD = /error|reject|refused|fail|denied/i;

const pad = (s, n) => String(s).padEnd(n);
const line = (c = '─', n = 78) => c.repeat(n);

function device(ua = '') {
  if (/iPhone|iPad|iPod/.test(ua)) {
    const v = (ua.match(/OS (\d+[_\d]*)/) || [])[1];
    return `${/iPad/.test(ua) ? 'iPad' : 'iPhone'} iOS ${(v || '?').replace(/_/g, '.')}`;
  }
  if (/Android/.test(ua)) {
    const v = (ua.match(/Android ([\d.]+)/) || [])[1];
    return `Android ${v || '?'}`;
  }
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/curl/i.test(ua)) return 'curl';
  return ua ? ua.slice(0, 24) : 'unknown';
}

// Events carry a UTC timestamp; a report read by a human in India should not.
const istTime = (iso) => {
  if (!iso) return '--:--:--';
  return new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(11, 19);
};

function describe(r) {
  const d = r.data || {};
  switch (r.event) {
    case 'pageview': return `${d.viewport || ''} ${d.net ? '· ' + d.net : ''} ${d.ref ? '· from ' + d.ref : ''}`.trim();
    case 'card:ready': return `${d.w}x${d.h} dpr ${d.dpr}${d.isIOS ? ' · iOS' : ''}`;
    case 'save:clicked': return `saved ${human(d.size || 0)}`;
    case 'save:start': return d.via ? `via ${d.via}` : '';
    case 'session:end': return `${(d.ms / 1000).toFixed(1)}s on page`;
    case 'video:play-rejected': return d.err || '';
    case 'js:error': return `${d.msg || ''} (${d.src || ''}:${d.line || ''})`;
    default: return d && Object.keys(d).length ? JSON.stringify(d).slice(0, 70) : '';
  }
}

// ---------------------------------------------------------------------------
try {
  const cfg = env();
  console.log(`\n${line('═')}`);
  console.log(`  ACTIVITY REPORT${DATE ? ` — ${DATE}` : ''}${SITE ? ` — ${SITE}` : ''}`
    + `${ERRORS_ONLY ? ' — PROBLEM SESSIONS ONLY' : ''}`);
  console.log(`  bucket ${cfg.bucket} · times shown in IST`);
  console.log(line('═'));

  const rows = dedupe(await loadEvents(cfg, { site: SITE, date: DATE }));
  if (!rows.length) {
    console.log('\n  No events found.');
    console.log('  Events from the last 10 minutes may still be compacting.\n');
    process.exit(0);
  }

  // ---- group: date -> session -------------------------------------------
  const byDate = new Map();
  for (const r of rows) {
    const d = (r.at || '').slice(0, 10) || 'unknown';
    if (!byDate.has(d)) byDate.set(d, new Map());
    const sessions = byDate.get(d);
    const sid = r.session || 'no-session';
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(r);
  }

  const totals = { events: 0, sessions: 0, problems: 0 };
  const byEvent = {}, byDevice = {}, byCountry = {};

  for (const d of [...byDate.keys()].sort().reverse()) {
    const sessions = byDate.get(d);

    // Order sessions by when they started, and sort events within a session by
    // `t` (ms since page load) rather than by arrival — a batch can be flushed
    // out of order, and `at` is only stamped per batch at the edge.
    const ordered = [...sessions.entries()]
      .map(([sid, evs]) => {
        evs.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
        return [sid, evs];
      })
      .sort((a, b) => String(a[1][0]?.at).localeCompare(String(b[1][0]?.at)));

    const shown = ordered.filter(([, evs]) => !ERRORS_ONLY || evs.some((e) => BAD.test(e.event)));
    if (!shown.length) continue;

    const dayEvents = ordered.reduce((n, [, e]) => n + e.length, 0);
    console.log(`\n\n${d}   ${ordered.length} session(s), ${dayEvents} events`);
    console.log(line('─'));

    for (const [sid, evs] of shown) {
      const first = evs[0];
      const pv = evs.find((e) => e.event === 'pageview');
      const problem = evs.some((e) => BAD.test(e.event));
      const dev = device(first.ua);

      totals.sessions++;
      totals.events += evs.length;
      if (problem) totals.problems++;
      byDevice[dev] = (byDevice[dev] || 0) + 1;
      byCountry[first.country || '--'] = (byCountry[first.country || '--'] || 0) + 1;

      console.log(`\n  ${problem ? '!!' : '  '} ${istTime(first.at)}  ${pad(dev, 20)}`
        + `  ${pad(first.country || '--', 3)} ${pad(first._stream || '', 6)} ${sid}`);
      if (pv?.data?.net) console.log(`       network ${pv.data.net}`
        + `${pv.data.saveData ? ' (data saver ON)' : ''}`
        + `${pv.data.standalone ? ' · standalone' : ''}`);

      for (const e of evs) {
        byEvent[e.event] = (byEvent[e.event] || 0) + 1;
        const t = e.t != null ? `${(e.t / 1000).toFixed(2)}s` : '';
        const mark = BAD.test(e.event) ? '!' : ' ';
        console.log(`     ${mark} ${pad(t, 8)} ${pad(e.event, 22)} ${describe(e)}`);
      }
    }
  }

  // ---- summary -----------------------------------------------------------
  console.log(`\n\n${line('═')}`);
  console.log('  SUMMARY');
  console.log(line('═'));
  console.log(`\n  ${totals.sessions} sessions · ${totals.events} events`
    + ` · ${totals.problems} session(s) with a problem\n`);

  console.log('  Activity');
  for (const [k, v] of Object.entries(byEvent).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(5)}  ${BAD.test(k) ? '!! ' : '   '}${k}`);
  }

  console.log('\n  Devices');
  for (const [k, v] of Object.entries(byDevice).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(5)}  ${k}`);
  }

  console.log('\n  Countries');
  for (const [k, v] of Object.entries(byCountry).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(5)}  ${k}`);
  }

  const objects = await listAll(cfg, 'logs/');
  const bytes = objects.reduce((n, o) => n + o.size, 0);
  console.log(`\n  Storage: ${objects.length} objects, ${human(bytes)}`
    + ` — ${(bytes / (2 * 1024 ** 3) * 100).toFixed(3)}% of the 2 GB sweeper budget\n`);
} catch (err) {
  console.error(`\nERROR: ${err.message}\n`);
  process.exit(1);
}
