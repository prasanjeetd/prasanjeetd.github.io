# logging — one telemetry endpoint for every site

A Cloudflare Worker that takes event batches from any of your static sites and
writes them to a single R2 bucket, one folder per site. Built to be reused:
adding a new site is one line in `wrangler.toml` and two lines in its HTML.

```
logging/
├── worker/
│   ├── wrangler.toml     bucket binding, allowed origins, sweeper budget
│   ├── src/index.js      ingest + 10-min compaction + daily sweeper
│   └── guard.test.mjs    tests the delete guard (node guard.test.mjs)
└── client/
    └── telemetry.js      drop-in browser snippet, identical on every site
```

## Why a Worker and not the site itself

A static page cannot hold a secret — anything it can use, a visitor can read.
The Worker holds the R2 binding server-side, so no key exists in any page or in
this repo. Sites are authorised by `Origin`, not by a token.

## Bucket layout

```
site-logs/                                  ← the bucket (second one, alongside live-assist-audio)
└── logs/                                   ← ROOT_PREFIX; everything this Worker owns
    ├── prasanjeet.com/
    │   ├── user/2026-08-12.jsonl           ← compacted, one file per day
    │   ├── user/raw/2026-08-12/…           ← loose, awaiting the 10-min fold
    │   └── app/2026-08-12.jsonl
    └── other-experiment.com/
        └── user/2026-08-12.jsonl
```

**R2 has no append.** You cannot add a line to an object, only replace it. So
each POST writes its own small object — visitors never overwrite one another —
and the cron folds the day's loose objects into one file every 10 minutes. That
file is the `user.log` you actually read.

## Deployed

**Live at `https://site-logs.office-product-style.workers.dev`** (2026-08-12),
bucket `site-logs` created, both cron triggers registered. Verified end to end:
a posted event reached R2 and appeared in the compacted day file 90 seconds
later.

No npm dependencies; the Worker uses only runtime APIs. To redeploy after a
change:

```bash
cd logging/worker
CLOUDFLARE_API_TOKEN=$CF_DEPLOY_TOKEN npx wrangler deploy
```

`CF_DEPLOY_TOKEN` is in `secret/.r2.secret` (gitignored) — the token named
`worker-logger` in the Cloudflare dashboard. It needs Workers Scripts:Edit,
Workers R2 Storage:Edit, Account Settings:Read, User Memberships:Read; a token
with less than that fails with `Authentication error [code: 10000]`.

Custom subdomains need the domain on Cloudflare DNS — prasanjeet.com is at
GoDaddy, so the `workers.dev` URL is the simple path and works fine.

## Wire a site in

```html
<script src="/logging/client/telemetry.js"></script>
<script>
  slog.init({
    endpoint: 'https://site-logs.<account>.workers.dev',
    site: 'prasanjeet.com',
    stream: 'user',
  });
</script>
```

Then `slog.event('video:play-rejected', { err: String(err) })` anywhere. A
`pageview` with full device info fires on init, and `session:end` with duration
fires on the way out, so you get sessions for free.

Add the new origin to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy —
that is the whole cost of onboarding another site.

### What gets recorded

Device and context, from the browser: user agent, screen and viewport, DPR,
language, timezone, **connection type** (`4g`/`3g` — the field that explains
most video complaints), device memory, CPU cores, touch points, standalone/PWA,
reduced-motion, referrer, path.

Added at the edge, where the page cannot fake it: timestamp, country, colo,
server-seen user agent.

**No IP address is stored**, and the session id is random per page load and
never persisted — events group into one visit, but nobody is followed between
visits. Country is enough to spot a regional fault and carries far less personal
data. It is still visitor data, so say so in the site's privacy note.

## Reading the logs

`tools/logs.mjs` wraps it — no arguments needed for the common case:

```bash
node logging/tools/logs.mjs summary          # today's events by type, iOS count
node logging/tools/logs.mjs today            # today's events, one per line
node logging/tools/logs.mjs today prasanjeet.com qr    # the launcher stream
node logging/tools/logs.mjs cat logs/prasanjeet.com/user/2026-08-12.jsonl
node logging/tools/logs.mjs ls               # every object + total vs budget
```

### A credential wrinkle worth knowing

`summary`, `today` and `cat` read through wrangler using `CF_DEPLOY_TOKEN`, so
they work with what you already have. **`ls` does not** — listing is the one
thing wrangler cannot do, so it signs an S3 request with
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, and those keys are scoped to
`live-assist-audio`. Against `site-logs` they return `403 AccessDenied`.

To enable `ls`, create an R2 API token covering both buckets (R2 → Manage API
Tokens) and replace the two values in `secret/.r2.secret`. Until then, the
Cloudflare dashboard's object browser does the same job.

Only compacted day files are readable this way. Events from the last ten
minutes are still loose under `raw/` with unpredictable keys, so they show up
after the next tick.

Or read it straight out of the bucket:

```bash
CLOUDFLARE_API_TOKEN=$CF_DEPLOY_TOKEN npx wrangler r2 object get \
  site-logs/logs/prasanjeet.com/user/2026-08-12.jsonl --file day.jsonl --remote

grep iPhone day.jsonl | grep play-rejected
```

## The sweeper

Runs daily at 03:19 UTC. Two rules, oldest first:

1. Anything older than `MAX_AGE_DAYS` (default 180) goes, regardless of size.
2. If the log prefix exceeds `SWEEP_AT` (85%) of `BUDGET_BYTES` (2 GB), it keeps
   deleting the oldest day files until back under `LOW_WATER` (70%). The gap
   between the two stops it re-running on every tick once it sits near the line.

`BUDGET_BYTES` is deliberately a **slice** of R2's 10 GB free tier, not the whole
thing. The allowance is account-wide, so capping logs at 2 GB means they can
never crowd out `live-assist-audio` in the same account.

### It cannot touch anything else

Two independent boundaries, because the sweeper is the only destructive code:

1. **Bucket.** The Worker's only R2 binding is `LOGS → site-logs`. There is no
   binding to `live-assist-audio`, so no code path can reach it. Enforced by
   Cloudflare, not by our logic.
2. **Prefix.** Within that bucket it only lists, reads, writes and deletes under
   `ROOT_PREFIX`, and every key is re-checked by `ownedKey()` immediately before
   deletion. All deletes funnel through one `safeDelete()`, so a later edit
   cannot forget the check. Anything else in the bucket is invisible to it.

`guard.test.mjs` imports the real `ownedKey` and asserts both directions —
that valid log keys are deletable, and that foreign prefixes, wrong extensions,
undated files and `../` traversal are not:

```bash
node guard.test.mjs      # all 17 cases pass
```

## Cost

Free at this volume. R2's allowance, **shared across all buckets in the account**:

| | Free/month | Logging uses |
|---|---|---|
| Storage | 10 GB | ~75 MB at 10k events/day |
| Class A (writes, lists) | 1,000,000 | ~4,300 |
| Class B (reads) | 10,000,000 | negligible |
| Egress | unlimited | — |
| Worker requests | 100,000/day | one per visit |

Deletes are not billed, so the sweeper costs nothing to run. Beyond the free
tier: $0.015/GB-month, $4.50/M Class A, $0.36/M Class B.
