const sessionsByTab = new Map();
const panelPorts = new Map();
const captureEnabledTabs = new Set();
const pendingSessionFlush = new Set(); // tabs with clicks captured before panel connected
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';
const LOG_PREFIX = '[GetDocumented:background]';
const WEB_APP_URL_PATTERNS = [
  'http://localhost:5173/*',
  'http://127.0.0.1:5173/*',
  'http://localhost:4173/*',
  'http://127.0.0.1:4173/*',
  'http://localhost:8080/*',
  'http://127.0.0.1:8080/*',
  'http://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com/*',
  'https://ec2-13-51-255-102.eu-north-1.compute.amazonaws.com/*'
];

const ACTIONS = {
  REQUEST_SESSION: 'REQUEST_SESSION',
  INTERACTION_CAPTURED: 'INTERACTION_CAPTURED',
  GET_CAPTURE_STATE: 'GET_CAPTURE_STATE',
  CAPTURE_STATE_CHANGED: 'CAPTURE_STATE_CHANGED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  STEP_CAPTURED: 'STEP_CAPTURED',
  DELETE_STEP: 'DELETE_STEP',
  REQUEST_AUTH_SYNC: 'REQUEST_AUTH_SYNC',
  AUTH_SESSION_SYNC: 'AUTH_SESSION_SYNC',
  AUTH_SESSION_CLEAR: 'AUTH_SESSION_CLEAR'
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.windowId) return;
  await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  console.debug(LOG_PREFIX, 'sidepanel connected');

  let tabId;

  port.onMessage.addListener(async (message) => {
    if (message.type === ACTIONS.REQUEST_SESSION) {
      console.debug(LOG_PREFIX, 'REQUEST_SESSION', message.tabId);
      const previousTabId = tabId;
      tabId = message.tabId;
      if (typeof tabId !== 'number') return;

      if (typeof previousTabId === 'number' && previousTabId !== tabId) {
        panelPorts.delete(previousTabId);
        await setCaptureEnabled(previousTabId, false);
      }

      panelPorts.set(tabId, port);
      await setCaptureEnabled(tabId, true);

      // Flush any clicks that arrived before the panel finished connecting
      void sendSessionUpdate(tabId);
      pendingSessionFlush.delete(tabId);

      await requestAuthSyncForAllTabs();
      return;
    }

    if (message.type === ACTIONS.REQUEST_AUTH_SYNC) {
      console.debug(LOG_PREFIX, 'REQUEST_AUTH_SYNC');
      await requestAuthSyncForAllTabs();
      return;
    }

    if (message.type === 'CLEAR_SESSION') {
      console.debug(LOG_PREFIX, 'CLEAR_SESSION', message.tabId);
      if (typeof message.tabId !== 'number') return;
      sessionsByTab.set(message.tabId, []);
      await chrome.storage.local.set({ [storageKey(message.tabId)]: [] });
      void sendSessionUpdate(message.tabId);
      return;
    }

    if (message.type === ACTIONS.DELETE_STEP) {
      console.debug(LOG_PREFIX, 'DELETE_STEP', message.tabId, message.stepId);
      if (typeof message.tabId !== 'number' || !message.stepId) return;
      await deleteStep(message.tabId, message.stepId);
      void sendSessionUpdate(message.tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (typeof tabId === 'number') {
      panelPorts.delete(tabId);
      void setCaptureEnabled(tabId, false);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === ACTIONS.GET_CAPTURE_STATE) {
    sendResponse({ ok: true, enabled: captureEnabledTabs.has(sender.tab?.id) });
    return false;
  }

  if (message?.type === ACTIONS.AUTH_SESSION_SYNC) {
    syncAuthSession(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === ACTIONS.AUTH_SESSION_CLEAR) {
    clearAuthSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== ACTIONS.INTERACTION_CAPTURED || !sender.tab?.id) {
    return false;
  }

  if (!captureEnabledTabs.has(sender.tab.id)) {
    console.debug(LOG_PREFIX, 'ignoring capture for inactive tab', { tabId: sender.tab.id });
    sendResponse({ ok: true, ignored: true });
    return false;
  }

  console.debug(LOG_PREFIX, 'INTERACTION_CAPTURED', { tabId: sender.tab.id, actionType: message.payload?.actionType, title: message.payload?.title });

  handleInteractionCapture(sender.tab, message.payload)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error(LOG_PREFIX, 'handleInteractionCapture failed', error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelPorts.delete(tabId);
  captureEnabledTabs.delete(tabId);
  pendingSessionFlush.delete(tabId);
});

async function handleInteractionCapture(tab, payload) {
  const tabId = tab.id;
  if (!tabId) return;

  const stored = await chrome.storage.local.get(AUTH_TOKEN_KEY);

  if (!stored[AUTH_TOKEN_KEY]) {
    console.warn(LOG_PREFIX, 'capture blocked, no auth token');
    // Notify the panel so the user sees a clear message instead of silent failure
    const port = panelPorts.get(tabId);
    if (port) {
      try {
        port.postMessage({
          type: 'AUTH_REQUIRED',
          message: 'Log in from the side panel to enable click capture.'
        });
      } catch {
        panelPorts.delete(tabId);
      }
    }
    return;
  }

  await showCaptureHighlight(tabId, payload.highlightRect);
  console.debug(LOG_PREFIX, 'capturing screenshot', { tabId, actionType: payload.actionType, title: payload.title });

  let screenshot;

  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png'
    });
  } finally {
    await clearCaptureHighlight(tabId);
  }

  const session = await getSession(tabId);
  const stepNumber = session.length + 1;

  const clickEntry = {
    id: crypto.randomUUID(),
    stepNumber,
    title: payload.title,
    description: payload.description || payload.title,
    detail: payload.detail || payload.selector || '',
    actionType: payload.actionType || 'click',
    selector: payload.selector,
    direction: payload.direction,
    clickPosition: payload.clickPosition,
    viewport: payload.viewport,
    pageUrl: tab.url,
    createdAt: new Date().toISOString(),
    screenshot
  };

  session.push(clickEntry);
  sessionsByTab.set(tabId, session);
  await chrome.storage.local.set({ [storageKey(tabId)]: session });
  console.debug(LOG_PREFIX, 'step stored', { tabId, stepNumber, sessionSize: session.length });

  if (!panelPorts.has(tabId)) {
    // Panel not yet connected — mark as pending; will flush on REQUEST_SESSION
    pendingSessionFlush.add(tabId);
  } else {
    sendStepUpdate(tabId, clickEntry);
  }
}

async function getSession(tabId) {
  if (sessionsByTab.has(tabId)) {
    return [...sessionsByTab.get(tabId)];
  }

  const key = storageKey(tabId);
  const stored = await chrome.storage.local.get(key);
  const session = Array.isArray(stored[key]) ? stored[key] : [];
  sessionsByTab.set(tabId, session);
  return [...session];
}

async function deleteStep(tabId, stepId) {
  const currentSession = await getSession(tabId);
  const nextSession = currentSession
    .filter((step) => step.id !== stepId)
    .map((step, index) => ({
      ...step,
      stepNumber: index + 1
    }));

  sessionsByTab.set(tabId, nextSession);
  await chrome.storage.local.set({ [storageKey(tabId)]: nextSession });
}

async function sendSessionUpdate(tabId) {
  const port = panelPorts.get(tabId);
  if (!port) return;

  const session = await getSession(tabId);

  try {
    console.debug(LOG_PREFIX, 'SESSION_UPDATED', { tabId, count: session.length });
    port.postMessage({
      type: ACTIONS.SESSION_UPDATED,
      tabId,
      payload: session
    });
  } catch {
    panelPorts.delete(tabId);
  }
}

function sendStepUpdate(tabId, step) {
  const port = panelPorts.get(tabId);
  if (!port) return;

  try {
    console.debug(LOG_PREFIX, 'STEP_CAPTURED', { tabId, stepNumber: step.stepNumber, title: step.title });
    port.postMessage({
      type: ACTIONS.STEP_CAPTURED,
      tabId,
      payload: step
    });
  } catch {
    panelPorts.delete(tabId);
  }
}

function storageKey(tabId) {
  return `session:${tabId}`;
}

async function setCaptureEnabled(tabId, enabled) {
  if (typeof tabId !== 'number') {
    return;
  }

  if (enabled) {
    // Mark the tab as capture-enabled *before* the async injection so that any
    // clicks the already-running content script fires during injection are not
    // silently dropped by the captureEnabledTabs guard in handleInteractionCapture.
    captureEnabledTabs.add(tabId);
    await ensureContentScriptInjected(tabId);
  } else {
    captureEnabledTabs.delete(tabId);
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: ACTIONS.CAPTURE_STATE_CHANGED,
      enabled
    });
  } catch {
    // Ignore tabs that do not currently have a content script context.
  }
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js']
    });
  } catch {
    // Ignore tabs that cannot be scripted. Existing content-script contexts still work.
  }
}

async function requestAuthSync(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: ACTIONS.REQUEST_AUTH_SYNC });
  } catch {
    // The active tab may not have a content script context we can message.
  }
}

async function requestAuthSyncForAllTabs() {
  const tabs = await chrome.tabs.query({ url: WEB_APP_URL_PATTERNS });

  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === 'number')
      .map(async (tab) => {
        await requestAuthSync(tab.id);
        await syncAuthSessionFromTab(tab.id);
      })
  );
}

async function syncAuthSession(payload) {
  await chrome.storage.local.set({
    [AUTH_TOKEN_KEY]: payload.token,
    [AUTH_USER_KEY]: payload.user
  });
}

async function clearAuthSession() {
  await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
}

async function syncAuthSessionFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const token = window.localStorage.getItem('getdocumented.auth.token');
          const rawUser = window.localStorage.getItem('getdocumented.auth.user');

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
    });

    const payload = results?.[0]?.result;

    if (payload?.token && payload?.user) {
      await syncAuthSession(payload);
    }
  } catch {
    // Ignore tabs that cannot be scripted.
  }
}

async function showCaptureHighlight(tabId, highlightRect) {
  if (!highlightRect) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [highlightRect],
      func: (rect) => {
        const existing = document.getElementById('__getdocumented-highlight');
        if (existing) {
          existing.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = '__getdocumented-highlight';
        overlay.style.position = 'fixed';
        overlay.style.left = `${Math.max(0, rect.left)}px`;
        overlay.style.top = `${Math.max(0, rect.top)}px`;
        overlay.style.width = `${Math.max(20, rect.width)}px`;
        overlay.style.height = `${Math.max(20, rect.height)}px`;
        overlay.style.borderRadius = `${rect.radius || 12}px`;
        overlay.style.pointerEvents = 'none';
        overlay.style.boxSizing = 'border-box';
        overlay.style.border = '3px solid rgba(236, 72, 153, 0.95)';
        overlay.style.background = 'rgba(244, 114, 182, 0.18)';
        overlay.style.boxShadow = '0 0 0 6px rgba(244, 114, 182, 0.14), 0 0 28px rgba(244, 114, 182, 0.45)';
        overlay.style.zIndex = '2147483647';
        overlay.style.transition = 'transform 120ms ease, opacity 120ms ease';
        overlay.style.transform = 'scale(0.98)';
        overlay.style.opacity = '0.98';

        document.documentElement.appendChild(overlay);

        requestAnimationFrame(() => {
          overlay.style.transform = 'scale(1)';
        });
      }
    });

    await delay(80);
  } catch {
    // Ignore highlight injection errors and continue with capture.
  }
}

async function clearCaptureHighlight(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.getElementById('__getdocumented-highlight')?.remove();
      }
    });
  } catch {
    // Ignore cleanup errors.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}