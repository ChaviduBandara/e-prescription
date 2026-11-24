// Copies browser libraries from node_modules into public/vendor/ so nothing
// is loaded from a CDN at runtime (CLAUDE.md hard rule 2).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'public', 'vendor');

const FILES = [
  {
    src: path.join(ROOT, 'node_modules', 'signature_pad', 'dist', 'signature_pad.umd.min.js'),
    dest: path.join(VENDOR_DIR, 'signature_pad.umd.min.js'),
    required: true
  },
  {
    src: path.join(ROOT, 'node_modules', 'signature_pad', 'dist', 'signature_pad.umd.min.js.map'),
    dest: path.join(VENDOR_DIR, 'signature_pad.umd.min.js.map'),
    required: false
  },
  {
    src: path.join(ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js'),
    dest: path.join(VENDOR_DIR, 'socket.io.min.js'),
    required: true
  },
  {
    src: path.join(ROOT, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js.map'),
    dest: path.join(VENDOR_DIR, 'socket.io.min.js.map'),
    required: false
  }
];

fs.mkdirSync(VENDOR_DIR, { recursive: true });

for (const file of FILES) {
  if (!fs.existsSync(file.src)) {
    if (file.required) {
      throw new Error(`copy-vendor: missing required source file ${file.src}`);
    }
    continue;
  }
  fs.copyFileSync(file.src, file.dest);
  console.log(`copy-vendor: ${path.relative(ROOT, file.dest)}`);
}
