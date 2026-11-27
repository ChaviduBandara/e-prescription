// Text in the archive PDF: Latin in Helvetica, Sinhala and Tamil in the
// bundled Noto fonts (src/fonts/, SIL Open Font License), picked per run of
// text. Nothing is downloaded at runtime (hard rule 2).
//
// Shaping is done by pdfkit's fontkit. Two known Sinhala gaps, both checked
// by rendering (see README "Session archive"):
// - repaya (ර + ් + ZWJ + consonant) is not formed; it prints as ර් followed
//   by the consonant, which reads the same.
// - fontkit's Indic shaper leaves some mark glyphs their own width, so the
//   rakaransaya after ක, ශ, ග … would be followed by a gap. HarfBuzz (what
//   browsers use) gives marks zero width by their GDEF class; zeroMarkWidths
//   below does the same for the Sinhala fonts only.
//
// A character no font here can print is never dropped or printed wrongly:
// it is shown as a red "?" and reported so the PDF can say so.
'use strict';

const path = require('path');

const FONT_DIR = path.join(__dirname, 'fonts');
const FONTS = {
  latin: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  sinhala: { regular: 'NotoSansSinhala', bold: 'NotoSansSinhala-Bold', files: ['NotoSansSinhala-Regular.ttf', 'NotoSansSinhala-Bold.ttf'] },
  tamil: { regular: 'NotoSansTamil', bold: 'NotoSansTamil-Bold', files: ['NotoSansTamil-Regular.ttf', 'NotoSansTamil-Bold.ttf'] }
};
const UNPRINTABLE_COLOR = '#b42318';

function scriptOf(cp) {
  if ((cp >= 0x0d80 && cp <= 0x0dff) || (cp >= 0x111e0 && cp <= 0x111ff)) return 'sinhala';
  if ((cp >= 0x0b80 && cp <= 0x0bff) || (cp >= 0x11fc0 && cp <= 0x11fff)) return 'tamil';
  return null;
}

// Spaces, digits, punctuation and joiners belong to whichever script they
// sit in, so "10mg" or "(…)" does not break a Sinhala run into pieces.
const NEUTRAL = /^[\s\d\p{P}‌‍]$/u;

// Helvetica is a standard PDF font with the WinAnsi character set. pdfkit
// prints anything outside it as a wrong character, so check first.
const WIN_ANSI_EXTRA = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2010, 0x2011, 0x2013, 0x2014,
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x202f,
  0x20ac, 0x2122
]);
function helveticaCan(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

// Registers the Noto fonts on `doc` and returns a context for textRuns and
// writeRich. Each document opens its own copies of the fonts.
function setUpFonts(doc) {
  const fontkitFonts = {};
  for (const script of ['sinhala', 'tamil']) {
    const { regular, bold, files } = FONTS[script];
    doc.registerFont(regular, path.join(FONT_DIR, files[0]));
    doc.registerFont(bold, path.join(FONT_DIR, files[1]));
    for (const name of [regular, bold]) {
      const fontkitFont = doc.font(name)._font.font;
      if (script === 'sinhala') zeroMarkWidths(fontkitFont);
      fontkitFonts[name] = fontkitFont;
    }
  }
  doc.font('Helvetica');
  return { fontkitFonts };
}

// Gives glyphs the font marks as combining marks (GDEF class 3) zero
// advance after layout, as HarfBuzz does for Sinhala. Their position is
// already set by the font's mark positioning, so only the gap goes. Marks
// that follow one (e.g. ී after the rakaransaya in ශ්‍රී) were placed
// counting its advance, so they get it back as offset and stay put.
function zeroMarkWidths(fontkitFont) {
  const classDef = fontkitFont.GDEF && fontkitFont.GDEF.glyphClassDef;
  if (!classDef) return;
  const isMark = (id) => glyphClass(classDef, id) === 3;
  const layout = fontkitFont.layout.bind(fontkitFont);
  fontkitFont.layout = (...args) => {
    const run = layout(...args);
    const { glyphs, positions } = run;
    for (let i = 0; i < glyphs.length; i++) {
      const advance = positions[i].xAdvance;
      if (!advance || !isMark(glyphs[i].id)) continue;
      positions[i].xAdvance = 0;
      for (let j = i + 1; j < glyphs.length && isMark(glyphs[j].id); j++) positions[j].xOffset += advance;
    }
    return run;
  };
}

function glyphClass(classDef, id) {
  if (classDef.version === 1) {
    const i = id - classDef.startGlyph;
    return i >= 0 && i < classDef.classValueArray.length ? classDef.classValueArray[i] : 0;
  }
  for (const range of classDef.classRangeRecord) if (id >= range.start && id <= range.end) return range.class;
  return 0;
}

// Splits `text` into runs: [{ text, font, unprintable }]. `unprintable`
// runs hold one "?" each, standing for a character no font can print;
// `missing` lists those characters as "U+XXXX".
function textRuns(ctx, text, { bold = false } = {}) {
  const weight = bold ? 'bold' : 'regular';
  const fontFor = (script) => FONTS[script][weight];
  const can = (script, cp) => (script === 'latin' ? helveticaCan(cp) : ctx.fontkitFonts[fontFor(script)].hasGlyphForCodePoint(cp));

  const runs = [];
  const missing = [];
  const push = (script, ch) => {
    const last = runs[runs.length - 1];
    if (last && !last.unprintable && last.script === script) last.text += ch;
    else runs.push({ script, font: fontFor(script), text: ch, unprintable: false });
  };

  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const own = scriptOf(cp);
    const current = runs.length && !runs[runs.length - 1].unprintable ? runs[runs.length - 1].script : null;
    let script = null;
    if (own) script = can(own, cp) ? own : null;
    else if (NEUTRAL.test(ch) && current && current !== 'latin' && can(current, cp)) script = current;
    else if (helveticaCan(cp)) script = 'latin';
    else if (NEUTRAL.test(ch) && can('sinhala', cp)) script = 'sinhala'; // e.g. a lone ZWJ
    if (script) push(script, ch);
    else {
      runs.push({ script: 'latin', font: fontFor('latin'), text: '?', unprintable: true });
      missing.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  return { runs, missing };
}

// pdfkit puts each font's baseline at its own ascender and moves down by
// the line height of whichever font ends a line. With fonts mixed in one
// paragraph that leaves "10mg" floating above Sinhala text and uneven
// lines. So every run gets the same baseline (the tallest ascender) and a
// lineGap that makes every line as tall as the tallest font's line.
function lineMetrics(doc, fonts, size) {
  let ascender = 0;
  let lineHeight = 0;
  for (const font of new Set(fonts)) {
    doc.font(font).fontSize(size);
    ascender = Math.max(ascender, (doc._font.ascender / 1000) * size);
    lineHeight = Math.max(lineHeight, doc.currentLineHeight(true));
  }
  return { ascender, lineHeight };
}

function runOptions(doc, metrics) {
  return { baseline: -metrics.ascender, lineGap: metrics.lineHeight - doc.currentLineHeight(true) };
}

// Writes runs as one paragraph. `x`, `y` and `options` (width…) are as for
// doc.text; color is the normal text color. Ends with Helvetica in black,
// so text written after it never inherits a Sinhala or Tamil font.
function writeRich(doc, runs, x, y, { size, color = 'black', ...options } = {}) {
  if (runs.length === 0) runs = [{ font: 'Helvetica', text: '' }];
  const metrics = lineMetrics(doc, runs.map((r) => r.font).concat('Helvetica'), size);
  runs.forEach((run, i) => {
    doc.font(run.font).fontSize(size).fillColor(run.unprintable ? UNPRINTABLE_COLOR : color);
    const more = { ...(i === 0 ? options : {}), ...runOptions(doc, metrics), continued: i < runs.length - 1 };
    if (i === 0 && x !== undefined) doc.text(run.text, x, y, more);
    else doc.text(run.text, more);
  });
  doc.font('Helvetica').fillColor('black');
}

// A height at least as tall as the runs will take at `width`: the text is
// measured in each run's font with the shared line height, tallest wins.
function heightOf(doc, runs, { size, width }) {
  const text = runs.map((r) => r.text).join('') || ' ';
  const fonts = runs.map((r) => r.font).concat('Helvetica');
  const metrics = lineMetrics(doc, fonts, size);
  let height = 0;
  for (const font of new Set(fonts)) {
    doc.font(font).fontSize(size);
    height = Math.max(height, doc.heightOfString(text, { width, ...runOptions(doc, metrics) }));
  }
  doc.font('Helvetica');
  return height;
}

module.exports = { setUpFonts, textRuns, writeRich, heightOf, lineMetrics, runOptions, zeroMarkWidths, helveticaCan, FONT_DIR, UNPRINTABLE_COLOR };
