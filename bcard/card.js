/* Static build — no server. Card shows on arrival and saves itself; the splash
   video plays fullscreen on tap. Everything here is browser API only, so this
   folder can sit on any static host (Netlify, Cloudflare Pages, S3, Pages). */
(() => {
  const CARD = {
    image: 'assets/prasanjeet-product-style-3.png',
    // Download filename base; a datetime is appended on every save.
    base: 'prasanjeet-product-style-3',
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

  // --- diagnostics: on-screen only, no endpoint to post to -----------------
  const DEBUG = /[?&]debug=1/.test(location.search);
  const dbg = DEBUG ? document.createElement('pre') : null;
  if (dbg) { dbg.id = 'dbg'; document.body.appendChild(dbg); }
  let seq = 0;
  function log(event, data) {
    if (!dbg) return;
    dbg.textContent += `${++seq} ${event} ${JSON.stringify(data || {})}\n`;
  }
  addEventListener('error', (e) => log('js:error', {
    msg: String(e.message), src: String(e.filename), line: e.lineno,
  }));
  addEventListener('unhandledrejection', (e) => log('js:reject', { reason: String(e.reason) }));

  log('pageview', { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, isIOS });

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
    try { video.currentTime = 0; } catch {}
    // The tap is a user gesture, so sound is allowed; a bare autoplay is not.
    video.muted = false;
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        log('video:play-rejected', { err: String(err) });
        video.muted = true;
        video.play().catch(closeSplash);
      });
    }
    // iPhone has no Fullscreen API for elements, but video carries its own.
    if (isIOS && video.webkitEnterFullscreen) {
      const go = () => { try { video.webkitEnterFullscreen(); } catch {} };
      if (video.readyState >= 1) go();
      else video.addEventListener('loadedmetadata', go, { once: true });
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
  video.addEventListener('error', () => { log('video:error'); closeSplash(); });
  splash.addEventListener('click', closeSplash);
  $('close').addEventListener('click', (e) => { e.stopPropagation(); closeSplash(); });

  const onFsChange = () => { if (!inFS() && open) closeSplash(); };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // --- on arrival ----------------------------------------------------------
  // Not gated on the load event: if it has already fired the handler never
  // runs and the save is silently skipped.
  setTimeout(async () => {
    if (await saveCard('auto')) showToast('✓ Saved to your phone');
    warmShare();
    // Warmed only after the card is up, so the 2.7 MB video never competes
    // with the card image for bandwidth.
    video.preload = 'auto';
    video.load();
  }, 1100);
})();
