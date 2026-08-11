/* Generates qr.png for wherever this folder is hosted.
 *
 *   node make-qr.mjs https://your-site.pages.dev
 *
 * The static build has no server to derive the URL from a request, so the QR
 * is produced once at deploy time instead of per request.
 */
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];

if (!url) {
  console.error('Usage: node make-qr.mjs <url-this-folder-is-hosted-at>');
  process.exit(1);
}

const out = path.join(__dirname, 'qr.png');
await QRCode.toFile(out, url, { width: 900, margin: 2 });

console.log(`\n  QR written to ${out}`);
console.log(`  Encodes: ${url}\n`);
