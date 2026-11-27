// Sinhala and Tamil in the archive PDF (src/pdf-text.js). Fake data only.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
// The fontkit pdfkit itself uses (not a direct dependency of this app).
const fontkit = require(require.resolve('fontkit', { paths: [require.resolve('pdfkit')] }));
const PDFDocument = require('pdfkit');
const { setUpFonts, textRuns, writeRich, zeroMarkWidths, helveticaCan, FONT_DIR } = require('../../src/pdf-text');

const SINHALA = path.join(FONT_DIR, 'NotoSansSinhala-Regular.ttf');

function newDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  return { doc, fonts: setUpFonts(doc) };
}

const summary = (runs) => runs.map((r) => [r.font, r.text, r.unprintable]);

test('text is split into runs per script; spaces, digits and punctuation stay with their script', () => {
  const { fonts } = newDoc();
  const { runs, missing } = textRuns(fonts, 'Test 10mg පෙති 1 (දිනකට) மாத்திரை 2');
  assert.deepEqual(missing, []);
  assert.deepEqual(summary(runs), [
    ['Helvetica', 'Test 10mg ', false],
    ['NotoSansSinhala', 'පෙති 1 (දිනකට) ', false],
    ['NotoSansTamil', 'மாத்திரை 2', false]
  ]);
  assert.equal(textRuns(fonts, 'ශ්‍රී', { bold: true }).runs[0].font, 'NotoSansSinhala-Bold', 'the ZWJ stays inside the Sinhala run');
  assert.equal(textRuns(fonts, 'டோக்கன்', { bold: true }).runs[0].font, 'NotoSansTamil-Bold');
});

test('characters no font can print become a visible "?" and are reported, never dropped', () => {
  const { fonts } = newDoc();
  const { runs, missing } = textRuns(fonts, 'Take → 2 😀 测 tablets');
  assert.deepEqual(missing, ['U+2192', 'U+1F600', 'U+6D4B']);
  assert.deepEqual(
    runs.filter((r) => r.unprintable).map((r) => r.text),
    ['?', '?', '?']
  );
  assert.equal(runs.map((r) => r.text).join(''), 'Take ? 2 ? ? tablets');
  // Helvetica's own set (WinAnsi) prints: accents, dashes, euro, quotes.
  for (const ch of 'é—€“”°µ½') assert.equal(helveticaCan(ch.codePointAt(0)), true, ch);
  assert.equal(helveticaCan(0x2192), false);
});

// Absolute x of each glyph's origin, in font units.
function glyphXs(run) {
  let pen = 0;
  return run.glyphs.map((g, i) => {
    const x = pen + run.positions[i].xOffset;
    pen += run.positions[i].xAdvance;
    return x;
  });
}

test('Sinhala rakaransaya adds no gap, and marks after it stay where the font puts them', () => {
  const plain = fontkit.openSync(SINHALA);
  const fixed = fontkit.openSync(SINHALA);
  zeroMarkWidths(fixed);

  // ක්‍ර is as wide as ක: the sign sits under the letter.
  assert.equal(fixed.layout('ක්‍ර').advanceWidth, fixed.layout('ක').advanceWidth);
  assert.ok(plain.layout('ක්‍ර').advanceWidth > plain.layout('ක').advanceWidth, 'unpatched fontkit leaves the gap');

  // ශ්‍රී: same glyphs at the same places; only the trailing gap is gone.
  const before = plain.layout('ශ්‍රී');
  const after = fixed.layout('ශ්‍රී');
  assert.deepEqual(after.glyphs.map((g) => g.id), before.glyphs.map((g) => g.id));
  assert.deepEqual(glyphXs(after), glyphXs(before));
  assert.equal(after.advanceWidth, fixed.layout('ශ').advanceWidth);
});

test('repaya is not formed by fontkit: ධර්‍ම prints like ධර්ම (documented limitation)', () => {
  const font = fontkit.openSync(SINHALA);
  zeroMarkWidths(font);
  const visible = (text) => {
    const run = font.layout(text);
    return run.glyphs.filter((g, i) => g.name !== 'space' || run.positions[i].xAdvance !== 0).map((g) => g.id);
  };
  assert.deepEqual(visible('ධර්‍ම'), visible('ධර්ම'));
});

test('mixed fonts share one baseline and one line pitch, and Helvetica is restored after', () => {
  const { doc, fonts } = newDoc();
  const fragments = [];
  const fragment = doc._fragment.bind(doc);
  doc._fragment = (text, x, y, options) => {
    // Where pdfkit puts this fragment's baseline (see its _fragment).
    const baselineY = typeof options.baseline === 'number' ? y - options.baseline : y + (doc._font.ascender / 1000) * doc._fontSize;
    fragments.push({ font: doc._font.name, y, baselineY });
    return fragment(text, x, y, options);
  };
  // Ends in Tamil, so a missing reset would leave the Tamil font active.
  const { runs } = textRuns(fonts, 'Test 10mg පෙති 1 Twice daily after meals, a long line that wraps மாத்திரை');
  writeRich(doc, runs, 50, 100, { size: 10.5, width: 150 });

  assert.ok(new Set(fragments.map((f) => f.font)).size >= 3);
  const lines = [...new Set(fragments.map((f) => f.y))];
  assert.ok(lines.length >= 3, 'the text wrapped');
  for (const y of lines) {
    const baselines = new Set(fragments.filter((f) => f.y === y).map((f) => f.baselineY.toFixed(3)));
    assert.equal(baselines.size, 1, `one baseline on the line at y=${y}`);
  }
  const pitches = new Set(lines.slice(1).map((y, i) => (y - lines[i]).toFixed(3)));
  assert.equal(pitches.size, 1, `every line equally tall: ${[...pitches]}`);
  assert.equal(doc._font.name, 'Helvetica', 'text written next is never in a Tamil or Sinhala font');
});
