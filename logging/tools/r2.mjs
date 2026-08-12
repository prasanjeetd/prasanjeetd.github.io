/* r2.mjs — minimal S3 client for the log bucket. No dependencies.
 *
 * Shared by logs.mjs and report.mjs. SigV4 is hand-rolled because the only
 * operation that genuinely needs S3 is LIST, which wrangler cannot do, and
 * pulling in an AWS SDK for one signed GET would add a node_modules tree to a
 * repo that otherwise has none.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SECRET = path.join(here, '..', '..', 'secret', '.r2.secret');

export function env() {
  let txt;
  try {
    txt = readFileSync(SECRET, 'utf8');
  } catch {
    throw new Error(`cannot read ${SECRET}\nThis file holds the R2 credentials and is gitignored.`);
  }
  const get = (k) => (txt.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();

  // LOGS_* first. The R2_* pair belongs to the live-assist-audio-rw token,
  // which is scoped to that bucket and 403s on site-logs; the LOGS_* pair is
  // derived from CF_DEPLOY_TOKEN, which covers all buckets.
  const cfg = {
    account: get('R2_ACCOUNT_ID'),
    key: get('LOGS_ACCESS_KEY_ID') || get('R2_ACCESS_KEY_ID'),
    secret: get('LOGS_SECRET_ACCESS_KEY') || get('R2_SECRET_ACCESS_KEY'),
    bucket: process.env.BUCKET || get('LOGS_BUCKET') || 'site-logs',
  };
  if (!cfg.account || !cfg.key || !cfg.secret) {
    throw new Error('secret/.r2.secret is missing R2_ACCOUNT_ID or the access key pair');
  }
  return cfg;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

// S3 wants each path segment encoded, but not the separators.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
  '%' + c.charCodeAt(0).toString(16).toUpperCase());

export async function s3(cfg, { path: p = '/', query = {} }) {
  const host = `${cfg.account}.r2.cloudflarestorage.com`;
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const region = 'auto';
  const service = 's3';

  // Canonical query string must be sorted by key, with both sides encoded.
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');

  const canonicalUri = '/' + [cfg.bucket, ...p.split('/').filter(Boolean)].map(enc).join('/');

  const payloadHash = sha256('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonicalRequest)].join('\n');

  let k = hmac(`AWS4${cfg.secret}`, date);
  for (const part of [region, service, 'aws4_request']) k = hmac(k, part);
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');

  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope},`
    + ` SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new Error('NOKEY');
    throw new Error(`${res.status} ${res.statusText}\n${text.slice(0, 300)}`);
  }
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

export async function listAll(cfg, prefix = 'logs/') {
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

export const human = (n) => n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1048576).toFixed(2)} MB`;

/* Reads every log object and returns flat event rows.
 * Both the compacted day files and the still-loose raw/ objects are included,
 * so events from the last ten minutes are not missing from the report. */
export async function loadEvents(cfg, { site, date } = {}) {
  const objects = await listAll(cfg, 'logs/');
  const wanted = objects.filter((o) => {
    if (site && !o.key.startsWith(`logs/${site}/`)) return false;
    if (date && !o.key.includes(date)) return false;
    return o.key.endsWith('.jsonl');
  });

  const rows = [];
  for (const o of wanted) {
    const m = o.key.match(/^logs\/([^/]+)\/([^/]+)\//);
    let text;
    try { text = await s3(cfg, { path: o.key }); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        r._site = m?.[1]; r._stream = m?.[2];
        rows.push(r);
      } catch { /* a truncated final line is not worth failing the report over */ }
    }
  }
  return rows;
}

/* The same event can be written twice if compaction wrote the day file but was
 * killed before deleting the raw objects it merged. Session+seq is unique per
 * page load, so it is the natural key to fold on. */
export function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.session}|${r.seq}|${r.event}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
