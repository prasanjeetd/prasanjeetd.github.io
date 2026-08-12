/* telemetry.js — drop-in event logging for a static site.
 *
 *   <script src="/logging/client/telemetry.js"></script>
 *   <script>
 *     slog.init({ endpoint: 'https://site-logs.<account>.workers.dev',
 *                 site: 'prasanjeet.com', stream: 'user' });
 *     slog.event('video:play-rejected', { err: String(err) });
 *   </script>
 *
 * No keys: the Worker authorises by Origin, so this file is safe in a public
 * repo and identical across every site. Only `site` changes.
 */
(() => {
  const cfg = { endpoint: '', site: '', stream: 'user', batch: 12, debug: false };

  // Random per page load, never stored. Enough to group one visit's events
  // together; deliberately not a cookie, so nobody is followed between visits.
  const session = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const t0 = Date.now();
  let queue = [];
  let seq = 0;
  let sent = false;

  // Everything the browser will tell us about the device, gathered once. This
  // is the half that explains failures — connection type and OS version are
  // what turn "video didn't work" into something you can act on.
  function device() {
    const c = navigator.connection || {};
    return {
      ua: navigator.userAgent,
      lang: navigator.language,
      tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone,
      screen: `${screen.width}x${screen.height}`,
      viewport: `${innerWidth}x${innerHeight}`,
      dpr: devicePixelRatio,
      net: c.effectiveType || null,
      downlink: c.downlink || null,
      saveData: !!c.saveData,
      mem: navigator.deviceMemory || null,
      cores: navigator.hardwareConcurrency || null,
      touch: navigator.maxTouchPoints || 0,
      standalone: !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      ref: document.referrer || null,
      url: location.pathname + location.search,
    };
  }

  function event(name, data) {
    if (!cfg.endpoint) return;
    queue.push({ session, seq: ++seq, t: Date.now() - t0, event: name, data: data || null });
    if (cfg.debug) console.log('[slog]', name, data || '');
    if (queue.length >= cfg.batch) flush();
  }

  function flush(final) {
    if (!queue.length || !cfg.endpoint) return;
    const events = queue;
    queue = [];

    const payload = JSON.stringify({ site: cfg.site, stream: cfg.stream, events });

    // keepalive lets the request outlive the page, which is the whole point on
    // pagehide — that final batch holds the session duration and whatever went
    // wrong last. sendBeacon would be the classic choice but cannot set
    // Content-Type reliably across browsers, and the Worker wants JSON.
    try {
      fetch(cfg.endpoint, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).catch(() => {});
    } catch {
      // Telemetry must never be able to break the page it is measuring.
    }
    if (final) sent = true;
  }

  function init(options) {
    Object.assign(cfg, options || {});
    if (!cfg.site || !cfg.endpoint) return;

    event('pageview', device());

    // Both, because iOS Safari frequently kills a tab without ever firing
    // pagehide; visibilitychange is the one that reliably arrives there.
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') endSession();
    });
    addEventListener('pagehide', endSession);

    addEventListener('error', (e) => event('js:error', {
      msg: String(e.message), src: String(e.filename), line: e.lineno,
    }));
    addEventListener('unhandledrejection', (e) => event('js:reject', { reason: String(e.reason) }));
  }

  function endSession() {
    if (sent) return;
    event('session:end', { ms: Date.now() - t0 });
    flush(true);
  }

  window.slog = { init, event, flush };
})();
