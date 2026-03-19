const CLICK_THROTTLE_MS = 250;
const AUTH_TOKEN_KEY = 'getdocumented.auth.token';
const AUTH_USER_KEY = 'getdocumented.auth.user';
const PAGE_BRIDGE_SOURCE = 'getdocumented-page-bridge';
const PAGE_BRIDGE_REQUEST_SOURCE = 'getdocumented-extension';
const PAGE_BRIDGE_REQUEST = 'GETDOCUMENTED_PAGE_BRIDGE_REQUEST';
const PAGE_BRIDGE_EVENT = 'GETDOCUMENTED_PAGE_BRIDGE_EVENT';
const WEB_APP_ORIGINS = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com',
  'https://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com'
]);
let lastClickAt = 0;
let extensionContextAvailable = true;

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

    void safeSendRuntimeMessage({
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
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== PAGE_BRIDGE_SOURCE || event.data?.type !== PAGE_BRIDGE_EVENT) return;

    const payload = event.data.payload;
    void safeSendRuntimeMessage({
      type: 'AUTH_SESSION_SYNC',
      payload
    });
  });

  injectPageBridgeScript();
}

function requestAuthSessionSnapshot() {
  window.postMessage(
    {
      source: PAGE_BRIDGE_REQUEST_SOURCE,
      type: PAGE_BRIDGE_REQUEST
    },
    window.location.origin
  );
}

function injectPageBridgeScript() {
  if (document.querySelector('script[data-getdocumented-page-bridge="true"]')) {
    return;
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/pageBridge.js');
  script.dataset.getdocumentedPageBridge = 'true';
  script.async = false;
  document.documentElement.appendChild(script);
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener('error', () => script.remove(), { once: true });
}

async function safeSendRuntimeMessage(message) {
  if (!extensionContextAvailable) {
    return;
  }

  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      extensionContextAvailable = false;
      return;
    }

    throw error;
  }
}

function isExtensionContextInvalidated(error) {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}