/* html.mjs — builds a self-contained HTML activity report for every site in
 * the bucket, then prints the path so logs.bat can open it.
 *
 *   node tools/html.mjs [--out path] [--date 2026-08-12] [--open]
 *
 * Four levels, each collapsible and each carrying its own overview:
 *   bucket -> site -> date -> session -> events
 *
 * No dependencies and no external assets: the file has to work when opened
 * straight off disk, so CSS and JS are inline.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env, loadEvents, dedupe, listAll, human } from './r2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// Stamped filename, IST, so reports accumulate in date order rather than each
// run destroying the last one.
const stamp = new Date(Date.now() + 5.5 * 3600e3).toISOString()
  .replace('T', '_').replace(/:/g, '').slice(0, 15);
const OUT = val('--out') || path.join(here, '..', 'reports', `activity-${stamp}-IST.html`);
const DATE = val('--date');
const BUDGET = 2 * 1024 ** 3;

const BAD = /error|reject|refused|fail|denied/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ist = (iso, fmt = 'time') => {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600e3);
  const s = d.toISOString();
  return fmt === 'time' ? s.slice(11, 19) : s.slice(0, 10);
};

function device(ua = '') {
  if (/iPhone|iPad|iPod/.test(ua)) {
    const v = (ua.match(/OS (\d+[_\d]*)/) || [])[1];
    return `${/iPad/.test(ua) ? 'iPad' : 'iPhone'} · iOS ${(v || '?').replace(/_/g, '.')}`;
  }
  if (/Android/.test(ua)) return `Android ${(ua.match(/Android ([\d.]+)/) || [])[1] || ''}`.trim();
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/curl/i.test(ua)) return 'curl';
  return ua ? ua.slice(0, 30) : 'unknown';
}

const iconFor = (d) => /iPhone|iPad/.test(d) ? '' : /Android/.test(d) ? '' : '';

function detail(r) {
  const d = r.data || {};
  switch (r.event) {
    case 'pageview': return [d.viewport, d.net, d.saveData ? 'data-saver' : '',
      d.standalone ? 'standalone' : '', d.ref ? `from ${d.ref}` : ''].filter(Boolean).join(' · ');
    case 'card:ready': return `${d.w}×${d.h} · dpr ${d.dpr}${d.isIOS ? ' · iOS' : ''}`;
    case 'save:clicked': return `saved ${human(d.size || 0)}`;
    case 'save:start': return d.via ? `via ${d.via}` : '';
    case 'session:end': return `${(d.ms / 1000).toFixed(1)}s on page`;
    case 'video:play-rejected': return d.err || '';
    case 'js:error': return `${d.msg || ''} — ${d.src || ''}:${d.line || ''}`;
    default: return d && Object.keys(d).length ? JSON.stringify(d) : '';
  }
}

// A horizontal breakdown bar, used for device / country / event mixes.
function bars(counts, limit = 8) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<div class="bars">${entries.map(([k, v]) => `
    <div class="bar-row${BAD.test(k) ? ' bad' : ''}">
      <span class="bar-label" title="${esc(k)}">${esc(k)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(v / max * 100).toFixed(1)}%"></span></span>
      <span class="bar-val">${v}</span>
    </div>`).join('')}</div>`;
}

const card = (label, value, sub = '') =>
  `<div class="card"><div class="card-v">${esc(value)}</div><div class="card-l">${esc(label)}</div>${
    sub ? `<div class="card-s">${esc(sub)}</div>` : ''}</div>`;

// ---------------------------------------------------------------------------
const cfg = env();
const objects = await listAll(cfg, 'logs/');
const bytes = objects.reduce((n, o) => n + o.size, 0);
const rows = dedupe(await loadEvents(cfg, { date: DATE }));

// site -> date -> session -> events
const tree = new Map();
for (const r of rows) {
  const site = r._site || 'unknown';
  const date = (r.at || '').slice(0, 10) || 'unknown';
  const sid = r.session || 'no-session';
  if (!tree.has(site)) tree.set(site, new Map());
  const dates = tree.get(site);
  if (!dates.has(date)) dates.set(date, new Map());
  const sessions = dates.get(date);
  if (!sessions.has(sid)) sessions.set(sid, []);
  sessions.get(sid).push(r);
}

let gEvents = 0, gSessions = 0, gProblems = 0;
const gDevices = {}, gCountries = {}, gEventTypes = {};
const siteBlocks = [];

for (const site of [...tree.keys()].sort()) {
  const dates = tree.get(site);
  let sEvents = 0, sSessions = 0, sProblems = 0;
  const sDevices = {}, sCountries = {}, sEventTypes = {}, sStreams = {};
  const dateBlocks = [];

  for (const date of [...dates.keys()].sort().reverse()) {
    const sessions = dates.get(date);
    const ordered = [...sessions.entries()]
      .map(([sid, evs]) => {
        // Sort by time-since-load, not arrival: a batch can be flushed out of
        // order and `at` is stamped per batch at the edge, not per event.
        evs.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
        return [sid, evs];
      })
      .sort((a, b) => String(b[1][0]?.at).localeCompare(String(a[1][0]?.at)));

    let dEvents = 0, dProblems = 0;
    const sessionBlocks = [];

    for (const [sid, evs] of ordered) {
      const first = evs[0];
      const pv = evs.find((e) => e.event === 'pageview');
      const end = evs.find((e) => e.event === 'session:end');
      const problem = evs.some((e) => BAD.test(e.event));
      const dev = device(first.ua);
      const country = first.country || '—';
      const stream = first._stream || '—';

      dEvents += evs.length; sEvents += evs.length; gEvents++;
      if (problem) { dProblems++; sProblems++; gProblems++; }
      sSessions++; gSessions++;
      sDevices[dev] = (sDevices[dev] || 0) + 1; gDevices[dev] = (gDevices[dev] || 0) + 1;
      sCountries[country] = (sCountries[country] || 0) + 1;
      gCountries[country] = (gCountries[country] || 0) + 1;
      sStreams[stream] = (sStreams[stream] || 0) + 1;
      for (const e of evs) {
        sEventTypes[e.event] = (sEventTypes[e.event] || 0) + 1;
        gEventTypes[e.event] = (gEventTypes[e.event] || 0) + 1;
      }

      const dur = end?.data?.ms ? `${(end.data.ms / 1000).toFixed(1)}s` : '—';
      const search = `${dev} ${country} ${stream} ${sid} ${evs.map((e) => e.event).join(' ')}`.toLowerCase();

      sessionBlocks.push(`
      <details class="session${problem ? ' problem' : ''}" data-search="${esc(search)}">
        <summary>
          <span class="dot"></span>
          <span class="s-time">${ist(first.at)}</span>
          <span class="s-dev">${esc(dev)}</span>
          <span class="pill">${esc(stream)}</span>
          <span class="pill ghost">${esc(country)}</span>
          <span class="s-meta">${evs.length} events · ${dur}</span>
          ${problem ? '<span class="pill err">problem</span>' : ''}
          <span class="s-id">${esc(sid)}</span>
        </summary>
        <div class="s-body">
          ${pv?.data ? `<div class="s-env">${[
            pv.data.viewport && `viewport ${esc(pv.data.viewport)}`,
            pv.data.dpr && `dpr ${esc(pv.data.dpr)}`,
            pv.data.net && `network ${esc(pv.data.net)}`,
            pv.data.lang && esc(pv.data.lang),
            pv.data.tz && esc(pv.data.tz),
            pv.data.cores && `${esc(pv.data.cores)} cores`,
            pv.data.mem && `${esc(pv.data.mem)} GB`,
          ].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>` : ''}
          <table class="events">
            <thead><tr><th>t</th><th>event</th><th>detail</th></tr></thead>
            <tbody>${evs.map((e) => `
              <tr class="${BAD.test(e.event) ? 'bad' : ''}">
                <td class="t">${e.t != null ? (e.t / 1000).toFixed(2) + 's' : '—'}</td>
                <td class="ev">${esc(e.event)}</td>
                <td class="dt">${esc(detail(e))}</td>
              </tr>`).join('')}</tbody>
          </table>
          <div class="s-ua">${esc(first.ua || '')}</div>
        </div>
      </details>`);
    }

    dateBlocks.push(`
    <details class="date" open>
      <summary>
        <span class="d-name">${esc(date)}</span>
        <span class="d-meta">${ordered.length} sessions · ${dEvents} events</span>
        ${dProblems ? `<span class="pill err">${dProblems} problem</span>` : ''}
      </summary>
      <div class="d-body">${sessionBlocks.join('')}</div>
    </details>`);
  }

  siteBlocks.push(`
  <details class="site" open>
    <summary>
      <span class="site-name">${esc(site)}</span>
      <span class="site-meta">${sSessions} sessions · ${sEvents} events</span>
      ${sProblems ? `<span class="pill err">${sProblems} problem</span>`
        : '<span class="pill ok">clean</span>'}
    </summary>
    <div class="site-body">
      <div class="grid3">
        <div class="panel"><h4>Devices</h4>${bars(sDevices)}</div>
        <div class="panel"><h4>Activity</h4>${bars(sEventTypes, 12)}</div>
        <div class="panel"><h4>Countries &amp; streams</h4>${bars({ ...sCountries, ...sStreams })}</div>
      </div>
      ${dateBlocks.join('')}
    </div>
  </details>`);
}

const generated = new Date();
const genIst = new Date(generated.getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activity report — ${esc(cfg.bucket)}</title>
<style>
  :root {
    --bg:#f6f7fb; --panel:#fff; --ink:#111827; --dim:#6b7280; --line:#e5e7eb;
    --accent:#2b8cff; --bad:#dc2626; --badbg:#fef2f2; --ok:#059669; --chip:#eef2ff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0c1222; --panel:#131c31; --ink:#e8edf7; --dim:#94a3b8; --line:#243049;
      --accent:#5aa2ff; --bad:#f87171; --badbg:#2a1414; --ok:#34d399; --chip:#1c2942;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 20px 80px; background:var(--bg); color:var(--ink);
    font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.3px; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:22px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:22px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card-v { font-size:24px; font-weight:650; letter-spacing:-.5px; }
  .card-l { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.6px; margin-top:2px; }
  .card-s { color:var(--dim); font-size:11px; margin-top:4px; }

  .toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:16px; }
  .toolbar input { flex:1; min-width:200px; padding:9px 12px; border-radius:9px;
    border:1px solid var(--line); background:var(--panel); color:var(--ink); font:inherit; }
  .toolbar button { padding:9px 14px; border-radius:9px; border:1px solid var(--line);
    background:var(--panel); color:var(--ink); font:inherit; cursor:pointer; }
  .toolbar button:hover { border-color:var(--accent); }
  .toolbar button.on { background:var(--accent); color:#fff; border-color:transparent; }

  details { border-radius:12px; }
  summary { cursor:pointer; list-style:none; display:flex; align-items:center; gap:10px;
    flex-wrap:wrap; user-select:none; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:'▸'; color:var(--dim); font-size:11px; transition:transform .15s; }
  details[open] > summary::before { transform:rotate(90deg); }

  .site { background:var(--panel); border:1px solid var(--line); margin-bottom:16px; }
  .site > summary { padding:14px 16px; font-weight:600; }
  .site-name { font-size:16px; }
  .site-meta, .d-meta, .s-meta { color:var(--dim); font-weight:400; font-size:12.5px; }
  .site-body { padding:0 16px 12px; }

  .grid3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin:4px 0 16px; }
  .panel { border:1px solid var(--line); border-radius:10px; padding:12px; }
  .panel h4 { margin:0 0 8px; font-size:11px; text-transform:uppercase; letter-spacing:.7px; color:var(--dim); }
  .bars { display:flex; flex-direction:column; gap:5px; }
  .bar-row { display:grid; grid-template-columns:1fr 90px 30px; align-items:center; gap:8px; font-size:12px; }
  .bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bar-track { background:var(--line); border-radius:99px; height:6px; overflow:hidden; }
  .bar-fill { display:block; height:100%; background:var(--accent); border-radius:99px; }
  .bar-row.bad .bar-fill { background:var(--bad); }
  .bar-row.bad .bar-label { color:var(--bad); }
  .bar-val { text-align:right; color:var(--dim); font-variant-numeric:tabular-nums; }

  .date { border:1px solid var(--line); margin-bottom:10px; }
  .date > summary { padding:10px 12px; font-weight:600; font-size:13.5px; }
  .d-body { padding:0 10px 8px; }

  .session { border-top:1px solid var(--line); }
  .session:first-child { border-top:0; }
  .session > summary { padding:9px 6px; font-size:13px; }
  .session.problem > summary { background:var(--badbg); border-radius:8px; }
  .dot { width:7px; height:7px; border-radius:99px; background:var(--ok); flex:none; }
  .session.problem .dot { background:var(--bad); }
  .s-time { font-variant-numeric:tabular-nums; color:var(--dim); }
  .s-dev { font-weight:600; }
  .s-id { margin-left:auto; color:var(--dim); font:11px ui-monospace,Consolas,monospace; }
  .s-body { padding:6px 6px 14px 24px; }
  .s-env { color:var(--dim); font-size:12px; margin-bottom:8px; }
  .s-ua { color:var(--dim); font:11px ui-monospace,Consolas,monospace;
    margin-top:8px; word-break:break-all; }

  .pill { font-size:11px; padding:2px 8px; border-radius:99px; background:var(--chip); color:var(--accent); }
  .pill.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); }
  .pill.err { background:var(--bad); color:#fff; }
  .pill.ok { background:transparent; border:1px solid var(--ok); color:var(--ok); }

  table.events { width:100%; border-collapse:collapse; font-size:12.5px; }
  table.events th { text-align:left; color:var(--dim); font-weight:500; font-size:11px;
    text-transform:uppercase; letter-spacing:.5px; padding:4px 8px; border-bottom:1px solid var(--line); }
  table.events td { padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  table.events tr:last-child td { border-bottom:0; }
  td.t { font-variant-numeric:tabular-nums; color:var(--dim); width:60px; }
  td.ev { font:12px ui-monospace,Consolas,monospace; width:190px; }
  td.dt { color:var(--dim); word-break:break-word; }
  tr.bad td.ev { color:var(--bad); font-weight:700; }
  tr.bad td.dt { color:var(--bad); }

  .empty { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:34px; text-align:center; color:var(--dim); }
  footer { margin-top:26px; color:var(--dim); font-size:12px; text-align:center; }
</style>
</head><body><div class="wrap">

<h1>Activity report</h1>
<div class="sub">
  Generated <strong>${esc(genIst)} IST</strong> · bucket <code>${esc(cfg.bucket)}</code>
  ${DATE ? `· filtered to ${esc(DATE)}` : ''}
</div>

<div class="cards">
  ${card('Sites', tree.size)}
  ${card('Sessions', gSessions)}
  ${card('Events', gEvents)}
  ${card('Problem sessions', gProblems, gProblems ? 'needs attention' : 'all clean')}
  ${card('Storage', human(bytes), `${(bytes / BUDGET * 100).toFixed(3)}% of 2 GB budget`)}
  ${card('Objects', objects.length)}
</div>

${gSessions ? `
<div class="grid3">
  <div class="panel"><h4>All devices</h4>${bars(gDevices, 10)}</div>
  <div class="panel"><h4>All activity</h4>${bars(gEventTypes, 14)}</div>
  <div class="panel"><h4>All countries</h4>${bars(gCountries, 10)}</div>
</div>

<div class="toolbar">
  <input id="q" placeholder="Filter sessions — try iPhone, video, error, IN…">
  <button id="probs">Problems only</button>
  <button id="expand">Expand all</button>
  <button id="collapse">Collapse all</button>
</div>

${siteBlocks.join('')}
` : `<div class="empty">
  <p><strong>No events yet.</strong></p>
  <p>Events posted in the last 10 minutes may still be compacting.</p>
</div>`}

<footer>site-logs · ${esc(objects.length)} objects · report regenerates from R2 each time you run logs.bat</footer>

</div>
<script>
  const q = document.getElementById('q');
  const sessions = () => [...document.querySelectorAll('.session')];
  let probsOnly = false;

  function apply() {
    const term = (q?.value || '').trim().toLowerCase();
    for (const s of sessions()) {
      const okText = !term || (s.dataset.search || '').includes(term);
      const okProb = !probsOnly || s.classList.contains('problem');
      s.style.display = okText && okProb ? '' : 'none';
    }
    // Hide a date or site whose sessions are all filtered out, so the page does
    // not fill with empty headings.
    for (const box of [...document.querySelectorAll('.date'), ...document.querySelectorAll('.site')]) {
      const kids = [...box.querySelectorAll('.session')];
      box.style.display = kids.length && kids.every((k) => k.style.display === 'none') ? 'none' : '';
    }
  }

  q?.addEventListener('input', apply);
  document.getElementById('probs')?.addEventListener('click', (e) => {
    probsOnly = !probsOnly;
    e.target.classList.toggle('on', probsOnly);
    apply();
  });
  document.getElementById('expand')?.addEventListener('click', () =>
    document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  document.getElementById('collapse')?.addEventListener('click', () =>
    document.querySelectorAll('.session, .date').forEach((d) => { d.open = false; }));
</script>
</body></html>`;

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log(path.resolve(OUT));
