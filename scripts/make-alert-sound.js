// Generates public/shared/alert.wav: a short two-note chime for the pharmacy
// screen. Run once with `node scripts/make-alert-sound.js`; the output is
// committed so no audio file is ever fetched from the internet.
'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 22050;
const NOTES = [
  { freq: 880, seconds: 0.18 },
  { freq: 1320, seconds: 0.32 }
];

const samples = [];
for (const { freq, seconds } of NOTES) {
  const count = Math.round(SAMPLE_RATE * seconds);
  for (let i = 0; i < count; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, i / (SAMPLE_RATE * 0.01));
    const decay = Math.exp((-4 * i) / count);
    samples.push(Math.sin(2 * Math.PI * freq * t) * attack * decay * 0.6);
  }
}

const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); // fmt chunk size
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
buf.writeUInt16LE(2, 32); // block align
buf.writeUInt16LE(16, 34); // bits per sample
buf.write('data', 36);
buf.writeUInt32LE(dataBytes, 40);
samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2));

const out = path.join(__dirname, '..', 'public', 'shared', 'alert.wav');
fs.writeFileSync(out, buf);
console.log(`wrote ${path.relative(process.cwd(), out)} (${buf.length} bytes)`);
