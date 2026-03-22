if (!window.__getdocumentedContentInstalled) {
  window.__getdocumentedContentInstalled = true;

  const CLICK_THROTTLE_MS = 250;
  const CHANGE_THROTTLE_MS = 400;
  const AUTH_TOKEN_KEY = 'getdocumented.auth.token';
  const AUTH_USER_KEY = 'getdocumented.auth.user';
  const PAGE_BRIDGE_SOURCE = 'getdocumented-page-bridge';
  const PAGE_BRIDGE_REQUEST_SOURCE = 'getdocumented-extension';
  const PAGE_BRIDGE_REQUEST = 'GETDOCUMENTED_PAGE_BRIDGE_REQUEST';
  const PAGE_BRIDGE_EVENT = 'GETDOCUMENTED_PAGE_BRIDGE_EVENT';
  const AUTH_SESSION_SYNC = 'AUTH_SESSION_SYNC';
  const AUTH_SESSION_CLEAR = 'AUTH_SESSION_CLEAR';
  const LOG_PREFIX = '[GetDocumented:content]';
  const WEB_APP_ORIGINS = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com',
    'https://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com'
  ]);
  let lastClickAt = 0;
  let lastChangeAt = 0;
  let extensionContextAvailable = true;
  let lastSyncedToken = null;

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
      actionType: 'click',
      title: buildActionTitle('click', target),
      description: buildActionDescription('click', target),
      detail: buildActionDetail(target),
      highlightRect: getHighlightRect(target, { x: event.clientX, y: event.clientY }),
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
      type: 'INTERACTION_CAPTURED',
      payload
    });
    console.debug(LOG_PREFIX, 'click captured', payload);
  },
  true
);

window.addEventListener(
  'change',
  (event) => {
    const now = Date.now();
    if (now - lastChangeAt < CHANGE_THROTTLE_MS) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    lastChangeAt = now;

    void safeSendRuntimeMessage({
      type: 'INTERACTION_CAPTURED',
      payload: {
        actionType: target instanceof HTMLSelectElement ? 'select' : 'input',
        title: buildFormActionTitle(target),
        description: buildFormActionDescription(target),
        detail: buildActionDetail(target),
        highlightRect: getHighlightRect(target),
        selector: buildSelector(target),
        direction: 'form',
        clickPosition: null,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      }
    });
    console.debug(LOG_PREFIX, 'form interaction captured', { actionType: target instanceof HTMLSelectElement ? 'select' : 'input', title: buildFormActionTitle(target) });
  },
  true
);

if (isWebAppPage()) {
  installAuthBridge();
  requestAuthSessionSnapshot();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SHOW_CAPTURE_ATTACHING') {
    showCaptureAttachingOverlay();
    return;
  }

  if (message?.type === 'HIDE_CAPTURE_ATTACHING') {
    hideCaptureAttachingOverlay();
    return;
  }

  if (message?.type === 'REQUEST_AUTH_SYNC' && isWebAppPage()) {
    requestAuthSessionSnapshot();
  }
});

function buildActionTitle(actionType, element) {
  const label = getElementLabel(element);
  return actionType === 'click' ? (label ? `Click ${label}` : 'Click highlighted item') : label || 'Capture interaction';
}

function buildActionDescription(actionType, element) {
  const label = getElementLabel(element);
  return actionType === 'click' ? (label ? `Click on ${label}` : 'Click on highlighted item') : label || 'Interaction recorded';
}

function buildFormActionTitle(element) {
  const fieldLabel = getFieldLabel(element);
  const valuePreview = getFieldValuePreview(element);

  if (element instanceof HTMLSelectElement) {
    return fieldLabel ? `Choose ${valuePreview} in ${fieldLabel}` : `Choose ${valuePreview}`;
  }

  return fieldLabel ? `Enter value in ${fieldLabel}` : 'Enter value';
}

function buildFormActionDescription(element) {
  const fieldLabel = getFieldLabel(element);
  const valuePreview = getFieldValuePreview(element);

  if (element instanceof HTMLSelectElement) {
    return fieldLabel ? `Select ${valuePreview} in the field ${fieldLabel}` : `Select ${valuePreview}`;
  }

  if (fieldLabel) {
    return valuePreview ? `Enter ${valuePreview} in the field ${fieldLabel}` : `Enter a value in the field ${fieldLabel}`;
  }

  return valuePreview ? `Enter ${valuePreview}` : 'Enter a value';
}

function buildActionDetail(element) {
  const fieldLabel = getFieldLabel(element);
  const elementLabel = getElementLabel(element);
  const pageLabel = document.title?.trim();
  return [fieldLabel || elementLabel, pageLabel].filter(Boolean).join(' • ');
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

function getHighlightRect(element, fallbackPoint = null) {
  const rect = element.getBoundingClientRect();
  const width = Math.max(rect.width || 0, 20);
  const height = Math.max(rect.height || 0, 20);

  if (width > 0 && height > 0) {
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(width),
      height: Math.round(height),
      radius: inferBorderRadius(element),
      mode: 'element'
    };
  }

  if (fallbackPoint) {
    return {
      left: Math.round(fallbackPoint.x - 18),
      top: Math.round(fallbackPoint.y - 18),
      width: 36,
      height: 36,
      radius: 999,
      mode: 'point'
    };
  }

  return null;
}

function showCaptureAttachingOverlay() {
  const existing = document.getElementById('__getdocumented-session-attach-overlay');
  if (existing) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = '__getdocumented-session-attach-overlay';
  overlay.setAttribute('aria-live', 'polite');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483646';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.background = 'rgba(15, 23, 42, 0.28)';
  overlay.style.backdropFilter = 'blur(2px)';
  overlay.style.pointerEvents = 'all';
  overlay.style.cursor = 'progress';

  const card = document.createElement('div');
  card.style.display = 'flex';
  card.style.alignItems = 'center';
  card.style.gap = '14px';
  card.style.padding = '18px 22px';
  card.style.borderRadius = '18px';
  card.style.background = 'rgba(255, 255, 255, 0.96)';
  card.style.boxShadow = '0 20px 60px rgba(15, 23, 42, 0.22)';
  card.style.color = '#0f172a';
  card.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
  card.style.fontSize = '16px';
  card.style.fontWeight = '700';
  card.style.letterSpacing = '0.01em';

  const spinner = document.createElement('div');
  spinner.style.width = '18px';
  spinner.style.height = '18px';
  spinner.style.borderRadius = '999px';
  spinner.style.border = '2px solid rgba(15, 23, 42, 0.18)';
  spinner.style.borderTopColor = '#0f172a';
  spinner.style.animation = '__getdocumented-spin 0.8s linear infinite';

  const text = document.createElement('span');
  text.textContent = 'Starting Capture';

  card.appendChild(spinner);
  card.appendChild(text);
  overlay.appendChild(card);

  if (!document.getElementById('__getdocumented-session-attach-style')) {
    const style = document.createElement('style');
    style.id = '__getdocumented-session-attach-style';
    style.textContent = '@keyframes __getdocumented-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.documentElement.appendChild(style);
  }

  document.documentElement.appendChild(overlay);
}

function hideCaptureAttachingOverlay() {
  document.getElementById('__getdocumented-session-attach-overlay')?.remove();
}

function inferBorderRadius(element) {
  try {
    const borderRadius = window.getComputedStyle(element).borderRadius;
    const parsed = Number.parseFloat(borderRadius);
    return Number.isFinite(parsed) ? Math.max(8, Math.round(parsed)) : 12;
  } catch {
    return 12;
  }
}

function getElementLabel(element) {
  const labelled = getAriaOrLabelText(element);
  if (labelled) return labelled;

  const text = element.textContent?.trim();
  if (text) {
    return text.replace(/\s+/g, ' ').slice(0, 80);
  }

  const title = element.getAttribute('title');
  if (title) return title.trim();

  const alt = element.getAttribute('alt');
  if (alt) return alt.trim();

  const placeholder = element.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();

  const value = element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.value?.trim() : '';
  if (value) return value.slice(0, 80);

  return humanizeIdentifier(element.id || element.getAttribute('name') || element.tagName.toLowerCase());
}

function getFieldLabel(element) {
  return getAriaOrLabelText(element) || humanizeIdentifier(element.getAttribute('name') || element.id || element.getAttribute('placeholder') || 'field');
}

function getAriaOrLabelText(element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const ariaLabelledBy = element.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const text = ariaLabelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');

    if (text) return text;
  }

  if ('labels' in element && element.labels?.length) {
    const text = Array.from(element.labels)
      .map((label) => label.textContent?.trim() || '')
      .filter(Boolean)
      .join(' ');

    if (text) return text;
  }

  const nearestLabel = element.closest('label');
  const nearestText = nearestLabel?.textContent?.trim();
  return nearestText || '';
}

function getFieldValuePreview(element) {
  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions?.[0]?.textContent?.trim() || 'selected option';
  }

  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return '';
  }

  const type = (element.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return 'a password value';
  if (type === 'checkbox' || type === 'radio') return element.checked ? 'selected' : 'cleared';

  const value = element.value?.trim();
  if (!value) return '';
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

function humanizeIdentifier(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
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

    void syncPayloadToExtension(event.data.payload, event.data.reason || 'change');
  });

  injectPageBridgeScript();
}

function requestAuthSessionSnapshot() {
  const localSession = readLocalAuthSession();

  if (localSession) {
    void syncPayloadToExtension(localSession, 'request');
    return;
  }

  window.postMessage(
    {
      source: PAGE_BRIDGE_REQUEST_SOURCE,
      type: PAGE_BRIDGE_REQUEST
    },
    window.location.origin
  );
}

function readLocalAuthSession() {
  try {
    const token = window.localStorage.getItem(AUTH_TOKEN_KEY);
    const rawUser = window.localStorage.getItem(AUTH_USER_KEY);

    if (!token || !rawUser) {
      return null;
    }

    return {
      token,
      user: JSON.parse(rawUser)
    };
  } catch {
    return null;
  }
}

async function syncPayloadToExtension(payload, reason) {
  if (payload?.token && payload?.user) {
    if (payload.token === lastSyncedToken) {
      return;
    }

    lastSyncedToken = payload.token;
    await safeSendRuntimeMessage({
      type: AUTH_SESSION_SYNC,
      payload
    });
    return;
  }

  if (reason === 'change') {
    lastSyncedToken = null;
    await safeSendRuntimeMessage({
      type: AUTH_SESSION_CLEAR
    });
  }
}

function injectPageBridgeScript() {
  if (!extensionContextAvailable) {
    return;
  }

  if (document.querySelector('script[data-getdocumented-page-bridge="true"]')) {
    return;
  }

  let scriptUrl;

  try {
    scriptUrl = chrome.runtime.getURL('src/pageBridge.js');
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      extensionContextAvailable = false;
      return;
    }

    throw error;
  }

  if (!scriptUrl || scriptUrl.startsWith('chrome-extension://invalid/')) {
    extensionContextAvailable = false;
    return;
  }

  const script = document.createElement('script');
  script.src = scriptUrl;
  script.dataset.getdocumentedPageBridge = 'true';
  script.async = false;
  document.documentElement.appendChild(script);
  script.addEventListener('load', () => script.remove(), { once: true });
  script.addEventListener(
    'error',
    () => {
      extensionContextAvailable = false;
      script.remove();
    },
    { once: true }
  );
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
      console.debug(LOG_PREFIX, 'extension context invalidated');
      return;
    }

    console.error(LOG_PREFIX, 'runtime message failed', message, error);
    throw error;
  }
}

function isExtensionContextInvalidated(error) {
  return error instanceof Error && /Extension context invalidated/i.test(error.message);
}
}
