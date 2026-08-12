/* Static build — no server. Card shows on arrival and saves itself; the splash
   video plays fullscreen on tap. Everything here is browser API only, so this
   folder can sit on any static host (Netlify, Cloudflare Pages, S3, Pages). */
(() => {
  const CARD = {
    image: 'assets/prasanjeet-product-style-3.png',
    // Download filename base; a datetime is appended on every save.
    base: 'prasanjeet-product-style-3',
    // Needed by the diagnostic probe, which fetches the video independently of
    // the <video> element to separate a network fault from a media fault.
    video: 'assets/splash.mp4',
  };

  const $ = (id) => document.getElementById(id);
  const frame = document.querySelector('.frame');
  const splash = $('splash');
  const video = $('vid');
  const toast = $('toast');
  const saveBtn = $('save');
  const shareBtn = $('share');

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // --- diagnostics ---------------------------------------------------------
  // Two sinks. `?debug=1` draws an on-screen trace, which is what you use when
  // the failing phone is in your hand. Everything also goes to the logging
  // Worker, which is what you use when it is in someone else's — this page had
  // no remote sink at all, so an iPhone that could not play the splash video
  // reported nothing and the cause had to be inferred from the file instead.
  const DEBUG = /[?&]debug=1/.test(location.search);
  const dbg = DEBUG ? document.createElement('pre') : null;
  if (dbg) { dbg.id = 'dbg'; document.body.appendChild(dbg); }
  let seq = 0;
  function paint(event, data) {
    if (!dbg) return;
    dbg.textContent += `${++seq} ${event} ${JSON.stringify(data || {})}\n`;
  }
  function log(event, data) {
    if (window.slog) window.slog.event(event, data);
    paint(event, data);
  }
  // Overlay only, deliberately: slog installs its own error and rejection
  // handlers, so routing these through log() as well would file every crash
  // twice in R2. paint() keeps them visible on screen without the duplicate.
  addEventListener('error', (e) => paint('js:error', {
    msg: String(e.message), src: String(e.filename), line: e.lineno,
  }));
  addEventListener('unhandledrejection', (e) => paint('js:reject', { reason: String(e.reason) }));

  // Not 'pageview' — slog.init() already sends one carrying the full device
  // profile. This is the card-specific half, kept separate so the two do not
  // collide in the logs.
  log('card:ready', { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, isIOS });

  // Sampled before anything can fail. An empty string here means WebKit rejects
  // the codec outright, which would be a verdict on the file; "probably" means
  // it accepts the format and any later failure is about delivery or timing,
  // not the encoding. Asking only after an error cannot separate the two.
  log('video:support', {
    mp4: video.canPlayType('video/mp4') || 'no',
    main31: video.canPlayType('video/mp4; codecs="avc1.4d401f"') || 'no',
    pair: video.canPlayType('video/mp4; codecs="avc1.4d401f, mp4a.40.2"') || 'no',
    baseline: video.canPlayType('video/mp4; codecs="avc1.42E01E"') || 'no',
    aac: video.canPlayType('audio/mp4; codecs="mp4a.40.2"') || 'no',
  });

  // --- save ----------------------------------------------------------------
  function filename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
      + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return `${CARD.base}-${stamp}.png`;
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2600);
  }

  // Fetched once and reused by both save and share.
  let cachedBlob = null;
  async function getBlob() {
    if (cachedBlob) return cachedBlob;
    const res = await fetch(CARD.image);
    if (!res.ok) throw new Error('http ' + res.status);
    cachedBlob = await res.blob();
    return cachedBlob;
  }

  // The download goes through a blob URL rather than pointing straight at the
  // file. Static hosts commonly send `Content-Disposition: inline; filename=…`,
  // and that header outranks the download attribute — so a direct href saves
  // under the original name and silently loses the timestamp. A blob URL
  // carries no headers, which leaves the attribute authoritative.
  async function saveCard(via) {
    const name = filename();
    log('save:start', { via, name });
    if (!('download' in document.createElement('a'))) {
      log('save:no-download-attr', { via });
      return false;
    }
    try {
      const blob = await getBlob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      log('save:clicked', { via, name, blobHref: href.startsWith('blob:'), size: blob.size });
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      return true;
    } catch (err) {
      log('save:error', { via, err: String(err) });
      return false;
    }
  }

  // The anchor keeps a real href so it still saves if scripting fails — but the
  // scripted path is preferred, because only the blob route guarantees the
  // timestamped name survives the host's Content-Disposition header.
  saveBtn.setAttribute('download', filename());
  saveBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    log('save:btn-click');
    showToast('Saving…');
    if (!(await saveCard('button'))) {
      showToast('Could not save — try Share');
    }
  });

  // --- share: escape hatch when the download system itself is blocked ------
  // Android's download manager can be disabled or denied storage, and Chrome
  // reports nothing when it drops a download. The share sheet hands the image
  // to another app (Photos, Files, Drive) and never touches Downloads.
  function canShareFiles() {
    try {
      const probe = new File([new Blob(['x'])], 'x.png', { type: 'image/png' });
      return !!(navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch { return false; }
  }

  shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    log('share:click', { cached: !!cachedBlob });
    try {
      const file = new File([await getBlob()], filename(), { type: 'image/png' });
      await navigator.share({ files: [file], title: document.title });
      log('share:ok');
    } catch (err) {
      log('share:error', { err: String(err) });
    }
  });

  // Warmed from cache so the share sheet opens without a round trip. Sharing
  // needs a File, which is the one thing the plain anchor cannot provide.
  async function warmShare() {
    if (!canShareFiles()) return;
    try {
      const blob = await getBlob();
      shareBtn.hidden = false;
      log('share:ready', { size: blob.size });
    } catch (err) {
      log('share:warm-failed', { err: String(err) });
    }
  }

  // --- fullscreen ----------------------------------------------------------
  const inFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  // Must run synchronously inside the gesture handler: awaiting anything first
  // spends the transient activation and the request gets rejected.
  function enterFS(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!fn) { log('fs:unsupported'); return false; }
    try {
      const r = fn.call(el, { navigationUI: 'hide' });
      if (r && r.catch) r.catch((err) => log('fs:rejected', { err: String(err) }));
      return true;
    } catch (err) {
      log('fs:threw', { err: String(err) });
      return false;
    }
  }

  function exitFS() {
    if (!inFS()) return;
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) { try { const r = fn.call(document); if (r && r.catch) r.catch(() => {}); } catch {} }
  }

  // --- splash --------------------------------------------------------------
  let open = false;

  function openSplash() {
    if (open) return;
    open = true;
    log('video:open');
    document.body.classList.add('playing');
    splash.classList.add('show');
    // Rewind only once metadata exists. Seeking an unloaded element throws on
    // iOS, and the throw fires between the gesture and play() below.
    if (video.readyState >= 1) { try { video.currentTime = 0; } catch {} }
    // The tap is a user gesture, so sound is allowed; a bare autoplay is not.
    video.muted = false;
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        // Carrying the media state makes the rejection self-explanatory: a
        // NotSupportedError with an error code already set means the element
        // died during load and this tap never had a chance.
        log('video:play-rejected', { err: String(err), ...mediaState() });
        video.muted = true;
        video.play().catch(closeSplash);
      });
    }
    // iPhone has no Fullscreen API for elements, but video carries its own.
    // It must be called inside this same gesture. Deferring it to
    // loadedmetadata — as this did — puts it outside the transient activation,
    // so iOS rejects it on every cold tap and the catch swallows the error.
    // If metadata has not arrived yet we simply stay inline, which is what
    // playsinline is on the element for.
    if (isIOS && video.webkitEnterFullscreen && video.readyState >= 1) {
      try { video.webkitEnterFullscreen(); }
      catch (err) { log('fs:ios-threw', { err: String(err) }); }
    }
  }

  function closeSplash() {
    if (!open) return;
    open = false;
    log('video:close');
    document.body.classList.remove('playing');
    splash.classList.remove('show');
    try { video.pause(); } catch {}
    exitFS();
  }

  frame.addEventListener('click', () => { enterFS(splash); openSplash(); });
  $('play').addEventListener('click', (e) => { e.stopPropagation(); enterFS(splash); openSplash(); });
  video.addEventListener('ended', closeSplash);

  // MediaError codes, because "video:error" on its own says nothing useful:
  // 1 ABORTED and 2 NETWORK mean the fetch was interrupted, 3 DECODE means the
  // bytes arrived but could not be decoded, 4 SRC_NOT_SUPPORTED means the
  // source was rejected outright. Those need completely different fixes, and
  // the first iPhone log could not distinguish them.
  const MEDIA_ERR = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'];
  function mediaState() {
    const e = video.error;
    return {
      code: e ? e.code : null,
      name: e ? (MEDIA_ERR[e.code] || '?') : null,
      msg: e && e.message ? String(e.message) : '',
      readyState: video.readyState,
      networkState: video.networkState,
      src: video.currentSrc || '',
      canPlay: video.canPlayType('video/mp4; codecs="avc1.4d401f, mp4a.40.2"') || 'no',
    };
  }
  video.addEventListener('error', () => {
    log('video:error', mediaState());
    // Fired once, and only on failure: fetching the same URL by hand separates
    // "this device cannot reach the bytes" from "this device cannot decode
    // them". Without it a MediaError code alone cannot tell those apart.
    probe();
    recover();
    closeSplash();
  });

  // Once an element reaches NETWORK_NO_SOURCE it stays dead until load() is
  // called again — which is why, on the failing iPhones, every subsequent tap
  // rejected instantly no matter how long the user waited. The ordering fix
  // should stop it dying in the first place; this is the belt to that pair of
  // braces, and it makes the page self-healing against causes not yet
  // identified. Once only, and late enough that whatever cancelled the
  // network has finished.
  let recovered = false;
  function recover() {
    if (recovered) return;
    recovered = true;
    setTimeout(() => {
      if (open || video.readyState > 0) return;
      log('video:recover', { readyState: video.readyState, networkState: video.networkState });
      try { video.load(); } catch (err) { log('video:recover-failed', { err: String(err) }); }
    }, 2500);
  }

  // --- media trace ---------------------------------------------------------
  // The error event says the element died; these say how far it got first.
  // loadstart without loadedmetadata means it never parsed the header;
  // loadedmetadata then abort means something interrupted a load that was
  // working. That distinction is the whole diagnosis.
  const traceCount = {};
  ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
    'stalled', 'suspend', 'abort', 'emptied', 'waiting'].forEach((ev) => {
    video.addEventListener(ev, () => {
      // stalled and waiting can repeat indefinitely on a bad connection; a few
      // samples prove the pattern and the rest is noise.
      traceCount[ev] = (traceCount[ev] || 0) + 1;
      if (traceCount[ev] > 3) return;
      let buffered = '';
      try {
        const b = video.buffered;
        buffered = b.length ? `${b.start(0).toFixed(1)}-${b.end(b.length - 1).toFixed(1)}` : 'none';
      } catch { buffered = 'n/a'; }
      log(`video:${ev}`, {
        readyState: video.readyState, networkState: video.networkState, buffered,
      });
    });
  });

  let probed = false;
  async function probe() {
    if (probed) return;
    probed = true;
    try {
      const t0 = Date.now();
      const res = await fetch(CARD.video, { headers: { Range: 'bytes=0-1023' } });
      const buf = await res.arrayBuffer();
      // Bytes 4-8 of a valid MP4 are the string "ftyp". If those arrive intact
      // the file reached the device unmangled and the fault is in decoding.
      const sig = String.fromCharCode(...new Uint8Array(buf.slice(4, 8)));
      log('video:probe', {
        status: res.status,
        type: res.headers.get('content-type'),
        range: res.headers.get('content-range'),
        bytes: buf.byteLength,
        ftyp: sig,
        ms: Date.now() - t0,
      });
    } catch (err) {
      log('video:probe-failed', { err: String(err) });
    }
  }
  splash.addEventListener('click', closeSplash);
  $('close').addEventListener('click', (e) => { e.stopPropagation(); closeSplash(); });

  const onFsChange = () => { if (!inFS() && open) closeSplash(); };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // iOS native video fullscreen is outside the Fullscreen API, so
  // fullscreenchange never fires for it. Without this, dismissing the iPhone
  // player with Done left the splash overlay covering the card.
  video.addEventListener('webkitendfullscreen', () => { log('video:ios-fs-end'); closeSplash(); });

  // --- on arrival ----------------------------------------------------------
  // Not gated on the load event: if it has already fired the handler never
  // runs and the save is silently skipped.
  setTimeout(async () => {
    // Order matters, and the iPhone logs are why. Triggering the save first
    // fired a blob download, and WebKit treats that as a navigation and
    // cancels in-flight network requests — so the video load that used to run
    // straight afterwards was aborted the same millisecond, leaving a dead
    // element and MediaError 4 for the rest of the session. Warming the video
    // before the download means there is nothing in flight for it to cancel.
    warmVideo();

    if (await saveCard('auto')) showToast('✓ Saved to your phone');
    warmShare();
  }, 1100);

  // --- is the UI actually reachable? ---------------------------------------
  // A session that ends with no video:open cannot be told apart from "the user
  // never tapped" unless we know whether there was anything tappable on screen.
  // This measures the action bar and the card after the fade-in has finished:
  // where they are, whether they are inside the viewport, and whether anything
  // is painted over them. Cheap, once, and it settles the question from the
  // device rather than from a screenshot.
  setTimeout(() => {
    const vw = innerWidth, vh = innerHeight;
    const measure = (el, name) => {
      if (!el) return { [name]: 'MISSING' };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // What the browser thinks is on top at the element's own centre. If that
      // is not this element or its child, something is covering it.
      const mid = document.elementFromPoint(
        Math.min(Math.max(r.left + r.width / 2, 0), vw - 1),
        Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
      );
      return {
        [name]: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        [name + 'Vis']: r.width > 0 && r.height > 0 && r.bottom <= vh && r.top >= 0,
        [name + 'Op']: cs.opacity,
        [name + 'Disp']: cs.display,
        [name + 'Hit']: mid ? (el.contains(mid) || mid === el ? 'self' : (mid.id || mid.className || mid.tagName)) : 'none',
      };
    };
    const info = {
      vw, vh, dvh: document.documentElement.clientHeight,
      ...measure($('actions'), 'bar'),
      ...measure($('play'), 'play'),
      ...measure(frame, 'card'),
    };
    log('ui:reachable', info);

    // The bar is painted only by a CSS animation that starts at opacity 0. If
    // that animation never ran — throttled tab, an iOS quirk, anything — the
    // buttons stay permanently invisible with no error anywhere. Rather than
    // trust it, check and force it. By 2.6s the 1.5s-delayed fade is long done,
    // so a still-zero opacity means it is never coming.
    const bar = $('actions');
    if (bar && getComputedStyle(bar).opacity === '0' && !document.body.classList.contains('playing')) {
      bar.style.animation = 'none';
      bar.style.opacity = '1';
      log('ui:forced-actions-visible');
    }
  }, 2600);

  // The 1100 ms delay keeps all of this off the critical path so the 1.9 MB
  // video and the 1.2 MB card image never compete. The element is declared
  // preload="metadata" rather than "none": iOS refuses to fetch media without
  // a gesture, and "none" left readyState at 0, which blocked the iPhone
  // fullscreen path. Metadata is just the moov atom — 45 kB, since the file is
  // faststart — so the bandwidth argument still holds.

  // Upgrades preloading from metadata to the whole file — but only when the
  // element has nothing yet.
  //
  // load() is destructive: it discards whatever the element holds and starts
  // over. On iPhone, preload="metadata" had already produced a healthy element
  // (loadedmetadata, readyState 1) by 30 ms, and calling load() a second later
  // threw that away. Re-fetching then collided with the download and the
  // element never recovered. Guarding on readyState keeps the warm-up for
  // browsers that really did fetch nothing, and leaves a working element alone.
  function warmVideo() {
    if (open) return;
    const cold = video.readyState === 0;
    log('video:warm', {
      readyState: video.readyState, networkState: video.networkState, willLoad: cold,
    });
    // A healthy element is left completely alone — preload is not touched
    // either, since raising it to "auto" can start a buffer fetch, and a fetch
    // in flight is exactly what the download cancels. Nothing in flight,
    // nothing to cancel.
    if (!cold) return;
    video.preload = 'auto';
    video.load();
  }
})();
