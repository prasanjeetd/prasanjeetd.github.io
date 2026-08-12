/* Tests the one destructive path in the Worker.
 *
 *   node guard.test.mjs
 *
 * ownedKey() is imported from src/index.js rather than restated here, so this
 * exercises the regex that actually ships. The bucket is shared with
 * live-assist-audio, so a false positive here means deleting someone's audio.
 */
import { ownedKey } from './src/index.js';

const ROOT = 'logs/';

const cases = [
  // --- must be deletable: exactly what the Worker writes ------------------
  ['logs/prasanjeet.com/user/2026-08-12.jsonl', true],
  ['logs/prasanjeet.com/user/raw/2026-08-12/1770900000000-ab12cd34.jsonl', true],
  ['logs/prasanjeet.com/app/2026-08-12.jsonl', true],
  ['logs/other-experiment.com/user/2026-01-01.jsonl', true],

  // --- must never be deletable -------------------------------------------
  ['audio/session-9912.wav', false],                          // another prefix
  ['live-assist-audio/whatever.mp3', false],                  // another product
  ['recordings/2026-08-12.jsonl', false],                     // right shape, wrong root
  ['logsX/prasanjeet.com/user/2026-08-12.jsonl', false],      // prefix must end at /
  ['logs/../audio/session.wav', false],                       // traversal
  ['logs/prasanjeet.com/user/../../../audio/x.wav', false],   // traversal, deeper
  ['logs/prasanjeet.com/user/notadate.jsonl', false],         // undated file
  ['logs/prasanjeet.com/user/2026-08-12.wav', false],         // wrong extension
  ['logs/prasanjeet.com/2026-08-12.jsonl', false],            // missing stream
  ['logs/prasanjeet.com/user/extra/2026-08-12.jsonl', false], // unexpected depth
  ['logs/prasanjeet.com/user/raw/2026-08-12/x.wav', false],   // raw, wrong extension
  ['logs/', false],
  ['', false],
];

let failed = 0;
for (const [key, want] of cases) {
  const got = ownedKey(key, ROOT);
  if (got !== want) failed++;
  console.log(
    `${got === want ? 'PASS' : 'FAIL'}  deletable=${String(got).padEnd(5)}`
    + ` want=${String(want).padEnd(5)} ${JSON.stringify(key)}`
  );
}

console.log(failed ? `\n${failed} FAILURE(S)` : `\nall ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
