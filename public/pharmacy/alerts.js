// New-prescription alerts on the pharmacy screen: the "Start receiving" tap
// that unlocks sound, the alert chime, and a notice that stays until clicked.
const $ = (id) => document.getElementById(id);
const alertSound = new Audio('/shared/alert.wav');
let pending = []; // prescriptions announced since the notice was last dismissed

// Shows the gate until the pharmacist taps Start receiving, then calls
// onStart(). That tap is the user gesture browsers need before any sound.
export function setUpStartGate(onStart) {
  $('start-receiving').addEventListener('click', () => {
    unlockSound();
    $('start-gate').hidden = true;
    onStart();
  });
}

function unlockSound() {
  alertSound.muted = true;
  const result = alertSound.play();
  const unmute = () => {
    alertSound.pause();
    alertSound.currentTime = 0;
    alertSound.muted = false;
  };
  if (result && result.then) result.then(unmute, unmute);
  else unmute();
}

function playSound() {
  alertSound.currentTime = 0;
  const result = alertSound.play();
  // Should not happen after Start receiving, but never fail silently.
  if (result && result.catch) result.catch(() => ($('sound-hint').hidden = false));
}

$('sound-hint').addEventListener('click', () => {
  unlockSound();
  $('sound-hint').hidden = true;
});

export function announce(rx) {
  pending.push(rx);
  const latest = `${rx.id} for ${rx.patientRef}`;
  $('notice-text').textContent =
    pending.length === 1
      ? `New prescription ${latest}`
      : `${pending.length} new prescriptions. Latest: ${latest}`;
  $('notice').hidden = false;
  playSound();
}

export function dismissNotice() {
  pending = [];
  $('notice').hidden = true;
}

// A click anywhere on the notice dismisses it.
$('notice').addEventListener('click', dismissNotice);
