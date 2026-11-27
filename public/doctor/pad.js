// Handwriting pad: signature_pad on a canvas with Undo and Clear. Works
// with stylus, finger and mouse (pointer events).
// `SignaturePad` is the global from /vendor/signature_pad.umd.min.js.
//
// Two safety rules, both covered by e2e tests:
// 1. Once anything is drawn, the canvas bitmap is never resized or redrawn
//    for layout. If the pad's on-screen size changes (rotation, Split
//    View), it locks behind a message until the size is back, so no stroke
//    can be cut off or moved. See tests/e2e/pad-rotation.spec.js.
// 2. signature_pad draws each segment only when the next point arrives, so
//    the last segment of every stroke (all of a quick flick or tiny dash)
//    would be missing. drawTail() draws it. See tests/e2e/pad-marks.spec.js.

const OPTIONS = {
  penColor: '#111',
  minWidth: 1,
  maxWidth: 3.2,
  // Keep every point, so small handwriting stays sharp.
  throttle: 0,
  minDistance: 1,
  // Transparent background: an untouched canvas exports as all-zero
  // pixels, which is how the server spots an empty drawing.
  backgroundColor: 'rgba(0,0,0,0)'
};

const LANDSCAPE_MESSAGE = 'Rotate back to portrait to continue.';
const RESIZED_MESSAGE = 'Make the browser full screen in portrait to continue.';

export function createPad(canvas, { wrapper, undoButton, clearButton, lockedEl }) {
  const pad = new window.SignaturePad(canvas, OPTIONS);
  const ctx = canvas.getContext('2d');
  let drawSize = null; // the CSS size the bitmap was made for
  let lockMessage = null; // null when unlocked
  let waiting = null; // { strokes, size }: a saved drawing to put back (see load)

  // ---- Stroke ends -----------------------------------------------------------

  // Draws the final segment of a stroke as a round-capped line, the same
  // width signature_pad uses for its own two-point lines.
  function drawTail(points) {
    if (points.length < 2) return;
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = OPTIONS.minWidth + OPTIONS.maxWidth;
    ctx.lineCap = 'round';
    ctx.strokeStyle = OPTIONS.penColor;
    ctx.stroke();
    ctx.restore();
  }

  // fromData has the same gap as live drawing, so every redraw goes here.
  function redraw(strokes) {
    pad.fromData(strokes);
    for (const stroke of strokes) drawTail(stroke.points);
  }

  // ---- Size and lock -----------------------------------------------------------

  function isPortrait() {
    return window.innerHeight >= window.innerWidth;
  }

  function sameSize(a, b) {
    return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  }

  // Makes the bitmap match the on-screen box at full device resolution.
  // Only ever called while the pad is empty, so nothing can be lost.
  function sizeBitmap(box) {
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.round(box.width * ratio);
    canvas.height = Math.round(box.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    pad.clear();
    drawSize = { width: box.width, height: box.height };
  }

  function setLock(message) {
    lockMessage = message;
    lockedEl.textContent = message || '';
    lockedEl.hidden = !message;
    wrapper.classList.toggle('pad--locked', Boolean(message));
    refresh();
  }

  // Called when the pad is shown and on every resize.
  function fit() {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return; // hidden
    if (!isPortrait()) return setLock(LANDSCAPE_MESSAGE);
    if (waiting) {
      // A saved drawing goes back only at the size it was drawn at, onto a
      // fresh empty bitmap: drawn once, never scaled or resized.
      if (!sameSize(box, waiting.size)) return setLock(RESIZED_MESSAGE);
      sizeBitmap(box);
      redraw(waiting.strokes);
      waiting = null;
      return setLock(null);
    }
    if (pad.isEmpty()) {
      if (!drawSize || !sameSize(box, drawSize)) sizeBitmap(box);
      return setLock(null);
    }
    // Strokes exist: never touch the bitmap, only lock or unlock.
    setLock(sameSize(box, drawSize) ? null : RESIZED_MESSAGE);
  }

  // ---- Buttons -----------------------------------------------------------------

  function refresh() {
    const empty = pad.isEmpty();
    wrapper.classList.toggle('pad--drawn', !empty);
    undoButton.disabled = empty || Boolean(lockMessage);
    clearButton.disabled = empty || Boolean(lockMessage);
  }

  pad.addEventListener('beginStroke', () => {
    wrapper.classList.remove('pad--invalid');
    wrapper.classList.add('pad--drawn');
  });
  pad.addEventListener('endStroke', () => {
    const strokes = pad.toData();
    drawTail(strokes[strokes.length - 1].points);
    refresh();
  });

  undoButton.addEventListener('click', () => {
    const strokes = pad.toData();
    strokes.pop();
    redraw(strokes);
    refresh();
  });
  clearButton.addEventListener('click', () => {
    pad.clear();
    refresh();
  });
  window.addEventListener('resize', fit);
  refresh();

  return {
    fit,
    isEmpty: () => pad.isEmpty() && !waiting,
    // The strokes and the size they were drawn at, to save (see load).
    snapshot: () => ({ strokes: pad.toData(), size: drawSize }),
    // Puts back a snapshot, e.g. a send still waiting when the page was
    // reloaded. It appears as soon as the pad is shown at that size.
    load(snapshot) {
      pad.clear();
      waiting = snapshot;
      refresh();
      fit();
    },
    // The message to show, or null if the pad can be used and sent.
    lockMessage: () => lockMessage,
    clear() {
      waiting = null;
      pad.clear();
      wrapper.classList.remove('pad--invalid');
      refresh();
      fit(); // empty again, so it may resize to the current box
    },
    markInvalid(invalid) {
      wrapper.classList.toggle('pad--invalid', invalid);
    },
    // The drawing as PNG bytes, straight from the canvas bitmap.
    toPng() {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('toBlob failed'))), 'image/png');
      });
    }
  };
}
