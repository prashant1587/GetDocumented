importScripts('./config.js');

const ACTIVE_SESSION_KEY = 'session:active';
const sessionsByTab = new Map();
const panelPorts = new Map();
const captureEnabledTabs = new Set();
const pendingSessionFlush = new Set();
let captureSessionActive = false;
let activeCaptureTabId = null;
let suppressActivationCount = 0;
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';
const LOG_PREFIX = '[Tracely:background]';
const { WEB_APP_URL_PATTERNS } = GD_CONFIG;


const ACTIONS = {
  REQUEST_SESSION: 'REQUEST_SESSION',
  INTERACTION_CAPTURED: 'INTERACTION_CAPTURED',
  GET_CAPTURE_STATE: 'GET_CAPTURE_STATE',
  CAPTURE_STATE_CHANGED: 'CAPTURE_STATE_CHANGED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  STEP_CAPTURED: 'STEP_CAPTURED',
  DELETE_STEP: 'DELETE_STEP',
  START_CAPTURE_SESSION: 'START_CAPTURE_SESSION',
  STOP_CAPTURE_SESSION: 'STOP_CAPTURE_SESSION',
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
        if (captureSessionActive && previousTabId !== activeCaptureTabId) {
          await setCaptureEnabled(previousTabId, false);
        }
      }

      panelPorts.set(tabId, port);
      if (captureSessionActive) {
        await setCaptureEnabled(tabId, true);
      }

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
      await clearSession();
      if (typeof tabId === 'number') {
        void sendSessionUpdate(tabId);
      }
      return;
    }

    if (message.type === ACTIONS.DELETE_STEP) {
      console.debug(LOG_PREFIX, 'DELETE_STEP', message.tabId, message.stepId);
      if (!message.stepId) return;
      await deleteStep(message.stepId);
      if (typeof tabId === 'number') {
        void sendSessionUpdate(tabId);
      }
      return;
    }

    if (message.type === ACTIONS.START_CAPTURE_SESSION) {
      console.debug(LOG_PREFIX, 'START_CAPTURE_SESSION', message.tabId);
      if (typeof message.tabId !== 'number') return;
      const targetTab = await chrome.tabs.get(message.tabId).catch(() => null);
      const captureCompatibilityError = getCaptureCompatibilityError(targetTab);
      if (captureCompatibilityError) {
        captureSessionActive = false;
        activeCaptureTabId = null;
        try {
          port.postMessage({
            type: 'CAPTURE_ERROR',
            tabId: message.tabId,
            message: captureCompatibilityError
          });
        } catch {
          panelPorts.delete(message.tabId);
        }
        return;
      }
      captureSessionActive = true;
      activeCaptureTabId = message.tabId;
      await clearSession();
      const allTabs = await chrome.tabs.query({});
      await Promise.all(
        allTabs
          .filter((tab) => typeof tab.id === 'number' && !getCaptureCompatibilityError(tab))
          .map((tab) => setCaptureEnabled(tab.id, true))
      );
      await appendNavigationStep(message.tabId, { isStart: true });
      void sendSessionUpdate(message.tabId);
      return;
    }

    if (message.type === ACTIONS.STOP_CAPTURE_SESSION) {
      console.debug(LOG_PREFIX, 'STOP_CAPTURE_SESSION', message.tabId);
      captureSessionActive = false;
      if (typeof activeCaptureTabId === 'number') {
        await setCaptureEnabled(activeCaptureTabId, false);
      }
      activeCaptureTabId = null;
    }
  });

  port.onDisconnect.addListener(() => {
    if (typeof tabId === 'number') {
      panelPorts.delete(tabId);
      captureSessionActive = false;
      activeCaptureTabId = null;
      void disableAllCaptureTabs();
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

  if (!captureSessionActive || !captureEnabledTabs.has(sender.tab.id)) {
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
  if (tabId === activeCaptureTabId) {
    activeCaptureTabId = null;
  }
});

// Record a "Go to {tab}" step when the user switches tabs during capture.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!captureSessionActive) return;
  // Ensure the content script is running in the newly active tab so that
  // clicks on it are captured immediately — before the navigation step screenshot.
  await setCaptureEnabled(tabId, true);
  // Wait for the tab to finish painting before taking the screenshot.
  await delay(300);
  if (!captureSessionActive) return;
  console.debug(LOG_PREFIX, 'tab activated during capture, recording navigation step', { tabId });
  await appendNavigationStep(tabId);
});

// Enable capture on any new tab when a session is active.
chrome.tabs.onCreated.addListener((tab) => {
  if (!captureSessionActive || typeof tab.id !== 'number') return;
  console.debug(LOG_PREFIX, 'capture enabling new tab', { tabId: tab.id });
  // Tab is not loaded yet — onUpdated (status: 'complete') will inject and enable.
});

// When any tab navigates or a new tab finishes loading, enable capture on it.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!captureSessionActive) return;
  if (changeInfo.status !== 'complete') return;

  await setCaptureEnabled(tabId, true);
});


async function handleInteractionCapture(tab, payload) {
  const tabId = tab.id;
  if (!tabId) return;
  const captureCompatibilityError = getCaptureCompatibilityError(tab);

  if (captureCompatibilityError) {
    throw new Error(captureCompatibilityError);
  }

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

  // If this click triggered a navigation the tab may already be loading the next
  // page. Wait for it to settle before showing the highlight and capturing so we
  // never screenshot a blank / half-painted page.
  await waitForTabLoad(tabId);

  await showCaptureHighlight(tabId, payload.highlightRect);
  console.debug(LOG_PREFIX, 'capturing screenshot', { tabId, actionType: payload.actionType, title: payload.title });

  let screenshot;

  try {
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch {
      // Window may have changed active tabs mid-capture — retry after a short pause.
      await delay(300);
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
  } finally {
    await clearCaptureHighlight(tabId);
  }

  const session = await getSession();
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
  sessionsByTab.set(ACTIVE_SESSION_KEY, session);
  await chrome.storage.local.set({ [storageKey()]: session });
  console.debug(LOG_PREFIX, 'step stored', { tabId, stepNumber, sessionSize: session.length });

  if (!panelPorts.has(tabId)) {
    // Panel not yet connected — mark as pending; will flush on REQUEST_SESSION
    pendingSessionFlush.add(tabId);
  } else {
    sendStepUpdate(tabId, clickEntry);
  }
}

async function getSession() {
  if (sessionsByTab.has(ACTIVE_SESSION_KEY)) {
    return [...sessionsByTab.get(ACTIVE_SESSION_KEY)];
  }

  const key = storageKey();
  const stored = await chrome.storage.local.get(key);
  const session = Array.isArray(stored[key]) ? stored[key] : [];
  sessionsByTab.set(ACTIVE_SESSION_KEY, session);
  return [...session];
}

async function deleteStep(stepId) {
  const currentSession = await getSession();
  const nextSession = currentSession
    .filter((step) => step.id !== stepId)
    .map((step, index) => ({
      ...step,
      stepNumber: index + 1
    }));

  sessionsByTab.set(ACTIVE_SESSION_KEY, nextSession);
  await chrome.storage.local.set({ [storageKey()]: nextSession });
}

async function sendSessionUpdate(tabId) {
  const port = panelPorts.get(tabId);
  if (!port) return;

  const session = await getSession();

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

function storageKey() {
  return ACTIVE_SESSION_KEY;
}

async function clearSession() {
  sessionsByTab.set(ACTIVE_SESSION_KEY, []);
  await chrome.storage.local.set({ [storageKey()]: [] });
}

async function disableAllCaptureTabs() {
  const enabledTabIds = [...captureEnabledTabs];
  await Promise.all(enabledTabIds.map((tabId) => setCaptureEnabled(tabId, false)));
}

async function appendNavigationStep(tabId, { isStart = false } = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.windowId) {
      console.debug(LOG_PREFIX, 'appendNavigationStep: tab has no windowId', { tabId });
      return;
    }

    const compatError = getCaptureCompatibilityError(tab);
    if (compatError) {
      console.debug(LOG_PREFIX, 'appendNavigationStep: tab not capturable', { tabId, compatError });
      return;
    }

    // Ensure the window is focused — captureVisibleTab only works on focused windows.
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
      await delay(80);
    } catch {
      // Window may have been closed or already focused — proceed.
    }

    let screenshot;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (captureErr) {
      // Tab may not have painted yet — retry once after a short delay.
      console.debug(LOG_PREFIX, 'appendNavigationStep: captureVisibleTab failed, retrying', { tabId, err: captureErr?.message });
      await delay(400);
      try {
        screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (retryErr) {
        console.warn(LOG_PREFIX, 'appendNavigationStep: captureVisibleTab retry failed, skipping step', { tabId, err: retryErr?.message });
        return;
      }
    }

    const session = await getSession();
    const stepNumber = session.length + 1;
    const title = buildNavigationTitle(tab);

    const entry = {
      id: crypto.randomUUID(),
      stepNumber,
      title: isStart ? `Navigate to ${title}` : `Go to ${title}`,
      description: isStart ? `Capture started on ${title}.` : `Switch to ${title}.`,
      detail: tab.url || title,
      actionType: isStart ? 'navigate-start' : 'navigate-tab',
      selector: null,
      direction: isStart ? 'start' : 'tab-switch',
      clickPosition: null,
      viewport: null,
      pageUrl: tab.url || null,
      createdAt: new Date().toISOString(),
      screenshot
    };

    session.push(entry);
    sessionsByTab.set(ACTIVE_SESSION_KEY, session);
    await chrome.storage.local.set({ [storageKey()]: session });
    console.debug(LOG_PREFIX, 'appendNavigationStep: step recorded', { tabId, stepNumber, title: entry.title });
    broadcastSessionUpdate();
  } catch (err) {
    console.warn(LOG_PREFIX, 'appendNavigationStep: unexpected error', { tabId, err: err?.message });
  }
}

function broadcastSessionUpdate() {
  for (const [tabId] of panelPorts) {
    void sendSessionUpdate(tabId);
  }
}

function buildNavigationTitle(tab) {
  if (tab.title?.trim()) {
    return tab.title.trim();
  }

  try {
    return new URL(tab.url).hostname;
  } catch {
    return 'next';
  }
}

async function setCaptureEnabled(tabId, enabled) {
  if (typeof tabId !== 'number') {
    return;
  }

  if (enabled) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (getCaptureCompatibilityError(tab)) {
      captureEnabledTabs.delete(tabId);
      return;
    }

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
      files: ['src/config.js', 'src/content.js']
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

        // Two rAF calls ensure the element is painted before signalling ready.
        requestAnimationFrame(() => {
          overlay.style.transform = 'scale(1)';
          requestAnimationFrame(() => {
            window.__getdocumentedHighlightReady = true;
          });
        });
      }
    });

    // Poll until the content script confirms the highlight has painted,
    // then add a small buffer to let the composite frame settle.
    await waitForHighlight(tabId);
    await delay(32);
  } catch {
    // Ignore highlight injection errors and continue with capture.
  }
}

async function waitForHighlight(tabId, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.__getdocumentedHighlightReady === true
      });
      if (result) return;
    } catch {
      return;
    }
    await delay(16);
  }
}

async function clearCaptureHighlight(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.getElementById('__getdocumented-highlight')?.remove();
        window.__getdocumentedHighlightReady = false;
      }
    });
  } catch {
    // Ignore cleanup errors.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabLoad(tabId, timeoutMs = 4000) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  // Let the page paint at least one frame after load completes.
  await delay(100);
}

function getCaptureCompatibilityError(tab) {
  if (!tab?.id || !tab?.windowId) {
    return 'Unable to identify the active tab.';
  }

  const rawUrl = typeof tab.url === 'string' ? tab.url.trim() : '';
  if (!rawUrl) {
    return 'Capture is unavailable until this tab finishes loading a website.';
  }

  try {
    const { protocol } = new URL(rawUrl);
    if (protocol === 'http:' || protocol === 'https:') {
      return null;
    }
  } catch {
    return 'Capture works only on regular website tabs.';
  }

  return 'Capture works only on regular http or https pages.';
}
