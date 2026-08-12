/* site-logs — one logging endpoint for every site.
 *
 * Sites POST batches of events here; the Worker writes them to R2 through a
 * binding, so no access key exists in any page or in this repo. Layout:
 *
 *   <root>/<site>/<stream>/<YYYY-MM-DD>.jsonl          compacted, one per day
 *   <root>/<site>/<stream>/raw/<YYYY-MM-DD>/<ts>-<id>  loose, pre-compaction
 *
 * Writes land loose because R2 has no append: a batch cannot be added to an
 * existing object, only a whole object written. Loose objects mean concurrent
 * visitors never overwrite each other. The 10-minute cron then folds them into
 * the day's file, which is the thing you actually read.
 *
 * DELETION SAFETY — two independent boundaries, because the sweeper is the
 * only destructive thing here:
 *
 *   1. Bucket. The only R2 binding is LOGS -> site-logs. There is no binding
 *      to live-assist-audio or anything else, so no code path in this Worker
 *      can reach another bucket. That is enforced by Cloudflare, not by us.
 *   2. Prefix. Inside that bucket the Worker only ever reads, writes or
 *      deletes under ROOT_PREFIX, and every key is re-checked against
 *      ownedKey() immediately before deletion. Anything else living in the
 *      same bucket — now, or dropped in later by another tool — is invisible
 *      to the sweeper.
 */

const enc = new TextEncoder();

// ---------------------------------------------------------------- helpers ---
const day = (d = new Date()) => d.toISOString().slice(0, 10);

// Site and stream names become path segments, so they must not be able to
// escape their own prefix or collide. Anything unexpected is rejected rather
// than sanitised, because a silently renamed site is worse than a refused write.
const SEG = '[a-z0-9][a-z0-9.-]{0,62}';
const SAFE = new RegExp(`^${SEG}$`);

// Namespace for everything this Worker owns, so the bucket can be shared.
function root(env) {
  const r = (env.ROOT_PREFIX || 'logs/').replace(/^\/+/, '');
  return r.endsWith('/') ? r : `${r}/`;
}

// The whitelist for destruction. A key is deletable only if it sits under the
// root AND matches the exact shape this Worker writes. Everything else is left
// alone, whatever it is.
const OWNED = new RegExp(
  `^${SEG}/${SEG}/(raw/\\d{4}-\\d{2}-\\d{2}/[^/]+\\.jsonl|\\d{4}-\\d{2}-\\d{2}\\.jsonl)$`
);
// Exported so guard.test.mjs can exercise the real thing rather than a copy —
// a retyped regex in a test proves nothing about what actually ships.
export const ownedKey = (key, ROOT) => key.startsWith(ROOT) && OWNED.test(key.slice(ROOT.length));

// Every delete in this file goes through here. Nothing calls env.LOGS.delete
// directly, so the guard cannot be bypassed by a future edit that forgets it.
async function safeDelete(env, keys, ROOT) {
  const ok = keys.filter((k) => ownedKey(k, ROOT));
  const refused = keys.length - ok.length;
  if (refused) console.warn(JSON.stringify({ refusedDeletes: refused, sample: keys.find((k) => !ownedKey(k, ROOT)) }));
  for (let i = 0; i < ok.length; i += 1000) {
    await env.LOGS.delete(ok.slice(i, i + 1000));
  }
  return ok.length;
}

function allowed(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function cors(origin, env) {
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowed(env).includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// --------------------------------------------------------------- ingest -----
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const headers = cors(origin, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers });
    if (!headers['Access-Control-Allow-Origin']) {
      return new Response('origin not allowed', { status: 403, headers });
    }

    let body;
    try { body = await req.json(); } catch { return new Response('bad json', { status: 400, headers }); }

    const site = String(body.site || '').toLowerCase();
    const stream = String(body.stream || 'user').toLowerCase();
    const events = Array.isArray(body.events) ? body.events : [];

    if (!SAFE.test(site) || !SAFE.test(stream)) {
      return new Response('bad site/stream', { status: 400, headers });
    }
    if (!events.length) return new Response(null, { status: 204, headers });
    // A page has no reason to send more than this; the cap keeps one runaway
    // loop from filling the bucket.
    if (events.length > 200) events.length = 200;

    // Enriched server-side, where the page cannot lie about it. Country comes
    // from Cloudflare's edge; the IP is deliberately not recorded — country is
    // enough to spot a regional problem and carries far less personal data.
    const now = new Date();
    const meta = {
      at: now.toISOString(),
      country: req.cf?.country || null,
      colo: req.cf?.colo || null,
      ua: req.headers.get('User-Agent') || null,
    };

    const lines = events.map((e) => JSON.stringify({ ...meta, ...e })).join('\n') + '\n';
    const key = `${root(env)}${site}/${stream}/raw/${day(now)}/`
      + `${now.getTime()}-${crypto.randomUUID().slice(0, 8)}.jsonl`;

    await env.LOGS.put(key, enc.encode(lines), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });

    return new Response(null, { status: 204, headers });
  },

  async scheduled(event, env, ctx) {
    // One Worker, two schedules — the daily one sweeps, the frequent one folds.
    if (event.cron === '19 3 * * *') ctx.waitUntil(sweep(env));
    else ctx.waitUntil(compact(env));
  },
};

// -------------------------------------------------------------- listing -----
// R2 list() is paginated and truncates; without following the cursor the
// sweeper would only ever see the first page and under-report total size.
// Always called with the root prefix, so nothing outside it is even visible.
async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.LOGS.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// ------------------------------------------------------------ compaction ----
// Folds every loose object under .../raw/<date>/ into .../<date>.jsonl, then
// deletes the originals. Reading the day file back and rewriting it is safe
// here because cron is the only writer of that key — visitors only ever write
// loose objects, so there is no race to lose.
async function compact(env) {
  const ROOT = root(env);
  const objects = await listAll(env, ROOT);
  const groups = new Map();

  for (const obj of objects) {
    if (!ownedKey(obj.key, ROOT)) continue;
    const m = obj.key.slice(ROOT.length).match(/^(.+?)\/(.+?)\/raw\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) continue;
    const target = `${ROOT}${m[1]}/${m[2]}/${m[3]}.jsonl`;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target).push(obj.key);
  }

  for (const [target, keys] of groups) {
    const parts = [];
    const existing = await env.LOGS.get(target);
    if (existing) parts.push(await existing.text());

    for (const k of keys) {
      const o = await env.LOGS.get(k);
      if (o) parts.push(await o.text());
    }

    const merged = parts.join('');
    if (!merged) continue;

    await env.LOGS.put(target, enc.encode(merged), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });

    // Only after the merged file is durably written. If the Worker dies before
    // this line the loose objects survive and are folded in again next tick —
    // duplicated lines are recoverable, lost ones are not.
    await safeDelete(env, keys, ROOT);
  }
}

// --------------------------------------------------------------- sweeper ----
// Two rules, oldest-first in both cases:
//   1. anything past MAX_AGE_DAYS goes, whatever the size
//   2. if the total is over SWEEP_AT of BUDGET_BYTES, keep deleting the oldest
//      day files until back under LOW_WATER
// BUDGET_BYTES is a slice of R2's 10 GB account-wide free tier, not the whole
// thing, so logs can never squeeze live-assist-audio in the same account. Note
// the total measured here is the log prefix only — by design, since that is
// also the only thing the sweeper is permitted to delete.
async function sweep(env) {
  const ROOT = root(env);
  const budget = Number(env.BUDGET_BYTES) || 2 * 1024 ** 3;
  const high = budget * (Number(env.SWEEP_AT) || 0.85);
  const low = budget * (Number(env.LOW_WATER) || 0.70);
  const maxAge = Number(env.MAX_AGE_DAYS) || 180;

  const objects = (await listAll(env, ROOT)).filter((o) => ownedKey(o.key, ROOT));
  let total = objects.reduce((n, o) => n + o.size, 0);
  const before = total;

  // Sorted by the date in the key, not upload time: a compacted day file is
  // rewritten every 10 minutes, so its mtime says nothing about how old the
  // events inside it are.
  const dated = objects
    .map((o) => {
      const m = o.key.match(/(\d{4}-\d{2}-\d{2})/);
      return m ? { key: o.key, size: o.size, date: m[1] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  const cutoff = day(new Date(Date.now() - maxAge * 86400e3));
  const doomed = new Set();

  for (const o of dated) {
    if (o.date < cutoff) { doomed.add(o); total -= o.size; }
  }
  if (total > high) {
    for (const o of dated) {
      if (total <= low) break;
      if (doomed.has(o)) continue;
      doomed.add(o);
      total -= o.size;
    }
  }

  const deleted = await safeDelete(env, [...doomed].map((o) => o.key), ROOT);

  // Deletes are not billed in R2, so the sweeper itself costs nothing to run.
  console.log(JSON.stringify({
    scope: ROOT,
    objects: objects.length,
    deleted,
    freed: before - total,
    remaining: total,
    budget,
    pct: +(total / budget * 100).toFixed(1),
  }));
}
