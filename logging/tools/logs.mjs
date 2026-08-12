/* logs.mjs — list and read the log bucket from the command line.
 *
 *   node logging/tools/logs.mjs ls [prefix]        list objects (default logs/)
 *   node logging/tools/logs.mjs cat <key>          print one object
 *   node logging/tools/logs.mjs today [site] [stream]   today's compacted file
 *   node logging/tools/logs.mjs summary [site] [stream] today's events by type
 *
 * `wrangler r2 object` can only get/put a known key — it cannot list — so this
 * signs S3 requests directly. No dependencies: SigV4 is done with node:crypto.
 * Credentials come from secret/.r2.secret, which is gitignored.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET = path.join(here, '..', '..', 'secret', '.r2.secret');

function env() {
  const txt = readFileSync(SECRET, 'utf8');
  const get = (k) => (txt.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
  return {
    account: get('R2_ACCOUNT_ID'),
    key: get('R2_ACCESS_KEY_ID'),
    secret: get('R2_SECRET_ACCESS_KEY'),
    // BUCKET= overrides, which is how you check whether a 403 is a signing
    // fault or simply an access key scoped to a different bucket.
    bucket: process.env.BUCKET || get('LOGS_BUCKET') || 'site-logs',
  };
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

// S3 wants each path segment encoded, but not the separators.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
  '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function s3(cfg, { path: p = '/', query = {} }) {
  const host = `${cfg.account}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const region = 'auto';
  const service = 's3';

  // Canonical query string must be sorted by key, with both sides encoded.
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');

  const canonicalUri = '/' + [cfg.bucket, ...p.split('/').filter(Boolean)]
    .map(enc).join('/');

  const payloadHash = sha256('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amz, scope, sha256(canonicalRequest),
  ].join('\n');

  let k = hmac(`AWS4${cfg.secret}`, date);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');

  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope},`
    + ` SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text.slice(0, 400)}`);
  return text;
}

// R2 returns XML; only three fields are needed, so a regex beats a parser dep.
function parseList(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const f = (t) => (m[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
    out.push({ key: f('Key'), size: +f('Size'), modified: f('LastModified') });
  }
  return out;
}

async function listAll(cfg, prefix) {
  const objects = [];
  let token;
  do {
    const q = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) q['continuation-token'] = token;
    const xml = await s3(cfg, { query: q });
    objects.push(...parseList(xml));
    token = (xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/) || [])[1];
  } while (token);
  return objects;
}

// Reading one object goes through wrangler rather than S3. The existing
// R2_ACCESS_KEY_ID pair is scoped to live-assist-audio and returns 403 on
// site-logs, whereas CF_DEPLOY_TOKEN carries Workers R2 Storage:Edit and can
// read any bucket — so `today` and `summary` work with the credentials you
// already have. Only `ls` still needs S3, because wrangler cannot list.
function getViaWrangler(cfg, key) {
  const txt = readFileSync(SECRET, 'utf8');
  const token = (txt.match(/^CF_DEPLOY_TOKEN=(.+)$/m) || [])[1]?.trim();
  if (!token) throw new Error('CF_DEPLOY_TOKEN missing from secret/.r2.secret');

  const tmp = path.join(os.tmpdir(), `r2-${Date.now()}.jsonl`);
  // shell:true is required on Windows: since Node 20 a bare spawn of a .cmd
  // shim fails with EINVAL. That means arguments go through a shell, so the
  // two that can contain spaces or awkward characters are quoted.
  // One command string, not an args array: with shell:true Node warns
  // (DEP0190) that array args are concatenated rather than escaped. The two
  // interpolated values are a bucket/key we construct and a temp path we
  // construct, so quoting them here is the whole of the escaping needed.
  const r = spawnSync(
    `npx --yes wrangler r2 object get "${cfg.bucket}/${key}" --file "${tmp}" --remote`,
    { env: { ...process.env, CLOUDFLARE_API_TOKEN: token }, encoding: 'utf8', shell: true }
  );
  if (!existsSync(tmp)) {
    throw new Error(/does not exist/i.test(r.stderr + r.stdout) ? 'NOKEY' : (r.stderr || 'wrangler failed').trim());
  }
  const body = readFileSync(tmp, 'utf8');
  try { unlinkSync(tmp); } catch {}
  return body;
}

const human = (n) => n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1048576).toFixed(2)} MB`;

// ------------------------------------------------------------------ main ---
const [cmd = 'ls', a, b] = process.argv.slice(2);
const cfg = env();
const today = new Date().toISOString().slice(0, 10);

try {
  if (cmd === 'ls') {
    const prefix = a || 'logs/';
    const objects = await listAll(cfg, prefix);
    if (!objects.length) { console.log(`no objects under ${prefix}`); process.exit(0); }
    for (const o of objects) {
      console.log(`${human(o.size).padStart(9)}  ${o.modified.slice(0, 19)}  ${o.key}`);
    }
    const total = objects.reduce((n, o) => n + o.size, 0);
    const budget = 2 * 1024 ** 3;
    console.log(`\n${objects.length} objects, ${human(total)}`
      + ` — ${(total / budget * 100).toFixed(3)}% of the 2 GB sweeper budget`);

  } else if (cmd === 'cat') {
    if (!a) throw new Error('usage: cat <key>');
    process.stdout.write(getViaWrangler(cfg, a));

  } else if (cmd === 'today' || cmd === 'summary') {
    const site = a || 'prasanjeet.com';
    const stream = b || 'user';
    const key = `logs/${site}/${stream}/${today}.jsonl`;
    let text;
    try {
      text = getViaWrangler(cfg, key);
    } catch (err) {
      if (err.message !== 'NOKEY') throw err;
      // Events written in the last 10 minutes are still loose under raw/ and
      // have unpredictable keys, so finding them needs a list — which is the
      // one thing wrangler cannot do.
      console.log(`no compacted file for ${today} yet.`);
      console.log('Events posted in the last 10 minutes are still in raw/ and');
      console.log('appear after the next compaction tick (every :00, :10, :20 …).');
      process.exit(0);
    }
    const rows = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    if (cmd === 'today') {
      for (const r of rows) {
        console.log(`${(r.at || '').slice(11, 19)} ${(r.country || '--')} ${String(r.event).padEnd(22)}`
          + `${r.data ? JSON.stringify(r.data).slice(0, 90) : ''}`);
      }
      console.log(`\n${rows.length} events`);
    } else {
      const by = {};
      for (const r of rows) by[r.event] = (by[r.event] || 0) + 1;
      for (const [k, v] of Object.entries(by).sort((x, y) => y[1] - x[1])) {
        console.log(`${String(v).padStart(6)}  ${k}`);
      }
      const ios = rows.filter((r) => /iPhone|iPad/.test(r.ua || '')).length;
      console.log(`\n${rows.length} events, ${new Set(rows.map((r) => r.session)).size} sessions,`
        + ` ${ios} from iOS`);
    }

  } else {
    console.log('commands: ls [prefix] | cat <key> | today [site] [stream] | summary [site] [stream]');
  }
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
