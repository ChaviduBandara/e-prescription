// PIN screen in front of a page. Each page's HTML loads only this script,
// with <body class="locked" data-role="doctor|pharmacy">. Once this browser
// holds a valid login cookie for that role, it loads the page's own module.
// The cookie is httpOnly: the page never sees it, it only asks the server.
//
// The page module is loaded with import() rather than awaiting the login at
// the top of the module: top-level await made Windows WebKit sluggish.
import { el } from '/shared/client.js';

const SCREENS = {
  doctor: { title: 'Doctor', module: '/doctor/doctor.js' },
  pharmacy: { title: 'Pharmacy', module: '/pharmacy/pharmacy.js' }
};

export async function isLoggedIn(role) {
  try {
    const res = await fetch(`/api/auth/check?role=${role}`, { cache: 'no-store' });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

export async function requireLogin(role, title) {
  if (await isLoggedIn(role)) return unlock();
  await showPinScreen(role, title);
  unlock();
}

// Pages start with <body class="locked">, which hides everything but the
// PIN screen, so nothing flashes before the check.
function unlock() {
  document.body.classList.remove('locked');
}

function showPinScreen(role, title) {
  return new Promise((resolve) => {
    const input = el('input', {
      id: 'pin',
      className: 'pin__input',
      type: 'password',
      inputMode: 'numeric',
      autocomplete: 'off',
      maxLength: 32,
      required: true
    });
    const message = el('p', { className: 'msg msg--error', role: 'alert' });
    const button = el('button', { type: 'submit', className: 'btn btn--primary btn--xl' }, 'Unlock');
    const form = el(
      'form',
      { className: 'pin card', autocomplete: 'off' },
      el('h1', { className: 'pin__title' }, title),
      el('label', { className: 'pin__label', htmlFor: 'pin' }, 'Enter PIN'),
      input,
      button,
      message
    );
    const screen = el('main', { className: 'pin-screen' }, form);
    document.body.append(screen);
    input.focus();

    let lockTimer = null;
    function lockFor(seconds) {
      button.disabled = true;
      input.disabled = true;
      let left = seconds;
      const tick = () => {
        if (left <= 0) {
          clearInterval(lockTimer);
          button.disabled = false;
          input.disabled = false;
          message.textContent = '';
          input.focus();
          return;
        }
        message.textContent = `Too many wrong PINs. Try again in ${left} seconds.`;
        left -= 1;
      };
      tick();
      lockTimer = setInterval(tick, 1000);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      if (!input.value) {
        message.textContent = 'Enter the PIN.';
        return input.focus();
      }
      button.disabled = true;
      message.textContent = '';
      let res;
      let body = {};
      try {
        res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, pin: input.value })
        });
        body = await res.json().catch(() => ({}));
      } catch {
        button.disabled = false;
        message.textContent = 'Cannot reach the pharmacy PC. Check the connection and try again.';
        return;
      }
      input.value = '';
      button.disabled = false;
      if (res.ok) {
        screen.remove();
        return resolve();
      }
      if (res.status === 429) return lockFor(body.retryAfter || 60);
      message.textContent = body.error || 'Could not log in. Try again.';
      input.focus();
    });
  });
}

const screen = SCREENS[document.body.dataset.role];
if (screen) requireLogin(document.body.dataset.role, screen.title).then(() => import(screen.module));
