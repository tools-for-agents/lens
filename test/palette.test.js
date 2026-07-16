// The palette, graded by the kit's OWN rules — run with `node --test`.
//
// iris grades a GAME's declared palette two ways: every colour must be distinguishable from the
// others (`indistinct-roles`, redmean distance vs a tolerance), and text must clear contrastAA. Both
// questions apply to this stylesheet, and nothing was asking them — so lens shipped TWO greys nobody
// could tell apart, and the darker of the two was under AA on half the surfaces it was used on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// WCAG's own formula, inline. Not a copy of a DESIGN SYSTEM — a copy of a SPEC: relative luminance
// has one definition and it does not drift. (Importing cortex's copy would mean reaching across a
// repo boundary that does not exist in this checkout, and a test that silently falls back to a null
// helper is a test that passes for the wrong reason.)
const lum = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// 🔑 Read the REAL palette out of the page, not a copy of it — a copy passes forever while the page
// drifts, which is the failure mode this kit keeps finding.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const vals = (name) => [...new Set([...page.matchAll(new RegExp(`--${name}: *(#[0-9a-f]{3,8})`, 'gi'))].map((m) => m[1].toLowerCase()))];

// iris's own perceptual distance (redmean — src/core.js), and its own tolerance for a game palette.
const HEX = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const dist = (a, b) => { const rb = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rb / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rb) / 256) * db * db); };
const TOLERANCE = 30;   // iris/tokens.json's game.tolerance — the kit's own "can you tell these apart"

// The quiet inks: the greys this page uses for anything that is not primary text.
const QUIET = ['muted', 'dim', 'faint'];
// Every surface a quiet ink can land on.
const SURFACES = ['bg', 'bg-2', 'panel', 'panel-2'];

test('no two quiet inks are indistinct — one grey, one meaning', () => {
  for (let theme = 0; theme < 2; theme++) {
    const inks = QUIET.map((n) => [n, vals(n)[theme] ?? vals(n)[0]]).filter(([, v]) => v);
    for (let i = 0; i < inks.length; i++) {
      for (let j = i + 1; j < inks.length; j++) {
        const d = dist(HEX(inks[i][1]), HEX(inks[j][1]));
        assert.ok(d >= TOLERANCE,
          `${['dark', 'light'][theme]}: --${inks[i][0]} ${inks[i][1]} and --${inks[j][0]} ${inks[j][1]} are ${d.toFixed(1)} apart — `
          + `closer than iris's own ${TOLERANCE} tolerance. Two colours nobody can tell apart are one colour, `
          + `and the spare one is only ever the darker twin that fails AA where the other passes.`);
      }
    }
  }
});

test('every quiet ink clears AA on every surface it can land on', () => {
  for (let theme = 0; theme < 2; theme++) {
    for (const ink of QUIET) {
      const iv = vals(ink)[theme] ?? vals(ink)[0];
      if (!iv) continue;
      for (const surf of SURFACES) {
        const sv = vals(surf)[theme] ?? vals(surf)[0];
        if (!sv) continue;
        const r = contrast(iv, sv);
        assert.ok(r >= 4.5,
          `${['dark', 'light'][theme]}: --${ink} ${iv} on --${surf} ${sv} is ${r.toFixed(2)}:1 — under the 4.5 this kit declares. `
          + `(The search placeholder sat at 4.46:1 on --panel this way, and the eye cannot report it: a placeholder is not a text node.)`);
      }
    }
  }
});
