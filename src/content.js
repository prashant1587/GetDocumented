const CLICK_THROTTLE_MS = 250;
const AUTH_TOKEN_KEY = 'getdocumented.auth.token';
const AUTH_USER_KEY = 'getdocumented.auth.user';
const AUTH_SYNC_EVENT = 'getdocumented-extension-auth-sync';
const WEB_APP_ORIGINS = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);
let lastClickAt = 0;

window.addEventListener(
  'click',
  (event) => {
    const now = Date.now();
    if (now - lastClickAt < CLICK_THROTTLE_MS) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    lastClickAt = now;

    const payload = {
      title: buildElementTitle(target),
      selector: buildSelector(target),
      direction: getDirection(event.clientX, event.clientY),
      clickPosition: {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY)
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };

    chrome.runtime.sendMessage({
      type: 'CLICK_CAPTURED',
      payload
    });
  },
  true
);

if (isWebAppPage()) {
  installAuthBridge();
  requestAuthSessionSnapshot();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'REQUEST_AUTH_SYNC' && isWebAppPage()) {
    requestAuthSessionSnapshot();
  }
});

function buildElementTitle(element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const text = element.textContent?.trim();
  if (text) {
    return text.slice(0, 80);
  }

  const id = element.id ? `#${element.id}` : '';
  return `${element.tagName.toLowerCase()}${id}`;
}

function buildSelector(element) {
  const parts = [];
  let current = element;

  for (let depth = 0; current && depth < 4; depth += 1) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${current.id}`;
      parts.unshift(part);
      break;
    }

    const classes = [...current.classList].slice(0, 2).join('.');
    if (classes) {
      part += `.${classes}`;
    }

    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getDirection(x, y) {
  const horizontal = x < window.innerWidth / 3 ? 'left' : x > (window.innerWidth * 2) / 3 ? 'right' : 'center';
  const vertical = y < window.innerHeight / 3 ? 'top' : y > (window.innerHeight * 2) / 3 ? 'bottom' : 'middle';

  if (horizontal === 'center' && vertical === 'middle') {
    return 'center';
  }

  if (horizontal === 'center') {
    return vertical;
  }

  if (vertical === 'middle') {
    return horizontal;
  }

  return `${vertical}-${horizontal}`;
}

function isWebAppPage() {
  return WEB_APP_ORIGINS.has(window.location.origin);
}

function installAuthBridge() {
  window.addEventListener(AUTH_SYNC_EVENT, (event) => {
    const payload = event.detail;
    chrome.runtime.sendMessage({
      type: 'AUTH_SESSION_SYNC',
      payload
    });
  });
}

function requestAuthSessionSnapshot() {
  injectPageScript(() => {
    const emitSession = () => {
      let user = null;
      const rawUser = window.localStorage.getItem('getdocumented.auth.user');

      if (rawUser) {
        try {
          user = JSON.parse(rawUser);
        } catch {
          user = null;
        }
      }

      window.dispatchEvent(
        new CustomEvent('getdocumented-extension-auth-sync', {
          detail: {
            token: window.localStorage.getItem('getdocumented.auth.token'),
            user
          }
        })
      );
    };

    emitSession();
    window.addEventListener('storage', (storageEvent) => {
      if (storageEvent.key === 'getdocumented.auth.token' || storageEvent.key === 'getdocumented.auth.user') {
        emitSession();
      }
    });
  });
}

function injectPageScript(callback) {
  const script = document.createElement('script');
  script.textContent = `(${callback.toString()})();`;
  document.documentElement.appendChild(script);
  script.remove();
}
