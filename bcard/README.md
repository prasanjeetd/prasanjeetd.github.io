# bcard — the scannable business card

Lives at **https://prasanjeet.com/bcard/**. Scan the QR → the card fills the
screen and saves itself with a datetime filename → tap the card → the splash
video plays fullscreen with sound.

Browser APIs only, no build step and no server. Copied from
`ai automation/barcode-card/client`; the files are byte-identical to that build
apart from this README and `qr.png`, which is regenerated for the live URL.

```
bcard/
├── index.html      the card page — what the QR points at
├── qr.html         the launcher — shows the QR to scan
├── card.css        styles, animations, ambient glow, orbiting border
├── card.js         save / share / fullscreen / splash logic
├── vendor/
│   └── qrcode.min.js   QR encoder, bundled locally (24 kb, no CDN)
├── make-qr.mjs     optional: writes qr.png from the command line
├── qr.png          encodes https://prasanjeet.com/bcard/
└── assets/
    ├── prasanjeet-product-style-3.png   the card
    └── splash.mp4                       the logo animation
```

## The two pages

| Page | What it is |
|---|---|
| `index.html` | The card. This is what the QR opens. |
| `qr.html` | The launcher — draws the QR on screen so you can scan it off a monitor while testing, and offers it as a PNG for printing. |

`qr.html` builds the QR **in the browser** from `location`, so it always encodes
wherever the folder actually is — localhost, LAN IP, or the live domain — with
nothing to regenerate.

Every path in `index.html` and `card.js` is relative, which is what lets the
folder sit at `/bcard/` rather than a domain root. GitHub Pages redirects
`/bcard` to `/bcard/` on its own, so both spellings work.

The site is deliberately not linked to this page from anywhere — it is reached
by scanning the QR, or by typing the URL.

## Preview locally

```bash
npx serve . -l 5173
```

`http://localhost:5173/qr.html` on the laptop, then scan with a phone on the
same Wi-Fi. `http://localhost:5173` on its own is the card.

`?debug=1` prints an on-screen trace — the static build has no endpoint to post
logs to, so the overlay is the whole story.

## Reprinting the QR

Open https://prasanjeet.com/bcard/qr.html and hit **Download QR for printing**;
it encodes the live URL automatically. `make-qr.mjs` does the same from a
terminal, but needs the `qrcode` package, which this repo does not carry — run
it from the `barcode-card` project instead:

```bash
node make-qr.mjs https://prasanjeet.com/bcard/   # writes qr.png
```

## Swapping the card or video

Replace the files in `assets/`. If you rename them, update the two paths in
`index.html` and the `CARD` object at the top of `card.js`. `CARD.base` sets the
download filename prefix; the datetime is appended automatically.

## Notes

- **HTTPS is required in practice.** `navigator.share` needs a secure context,
  which means HTTPS or `localhost` — `file://` will not do. GitHub Pages serves
  HTTPS, so the deployed page is fine. Fullscreen and the download attribute
  work either way.
- **Saving is best effort, by design.** Chrome permits one automatic download
  per page load and silently drops the rest — no error, no event, nothing a
  page can detect. That is why the Save button is always on screen rather than
  appearing only after a failure.
- **Share exists for phones where downloads are blocked entirely.** If Android's
  download manager is disabled or denied storage, no download will ever land.
  The share sheet hands the PNG to Photos / Files / Drive instead and bypasses
  the Downloads folder completely. The button only appears where the browser
  actually supports sharing files.
- **`.nojekyll` at the repo root** is what keeps Pages from running the files
  through Jekyll. It is already there; do not remove it.
- **Cache busting** is the host's job. Pages sends ETags, but if you overwrite
  `card.js` in place, hard-refresh once.
