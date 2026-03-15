const sessionsByTab = new Map();
const panelPorts = new Map();
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';

const ACTIONS = {
  REQUEST_SESSION: 'REQUEST_SESSION',
  CLICK_CAPTURED: 'CLICK_CAPTURED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  REQUEST_AUTH_SYNC: 'REQUEST_AUTH_SYNC',
  AUTH_SESSION_SYNC: 'AUTH_SESSION_SYNC'
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

  let tabId;

  port.onMessage.addListener(async (message) => {
    if (message.type === ACTIONS.REQUEST_SESSION) {
      tabId = message.tabId;
      if (typeof tabId !== 'number') return;
      panelPorts.set(tabId, port);
      sendSessionUpdate(tabId);
      await requestAuthSync(tabId);
      return;
    }

    if (message.type === 'CLEAR_SESSION') {
      if (typeof message.tabId !== 'number') return;
      sessionsByTab.set(message.tabId, []);
      await chrome.storage.local.set({ [storageKey(message.tabId)]: [] });
      sendSessionUpdate(message.tabId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (typeof tabId === 'number') {
      panelPorts.delete(tabId);
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === ACTIONS.AUTH_SESSION_SYNC) {
    syncAuthSession(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== ACTIONS.CLICK_CAPTURED || !sender.tab?.id) {
    return false;
  }

  handleClickCapture(sender.tab, message.payload)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelPorts.delete(tabId);
});

async function handleClickCapture(tab, payload) {
  const tabId = tab.id;
  if (!tabId) return;

  const stored = await chrome.storage.local.get(AUTH_TOKEN_KEY);

  if (!stored[AUTH_TOKEN_KEY]) {
    throw new Error('Authentication required. Log in from the extension side panel to enable capture.');
  }

  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png'
  });

  const session = await getSession(tabId);
  const stepNumber = session.length + 1;

  const clickEntry = {
    id: crypto.randomUUID(),
    stepNumber,
    title: payload.title,
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

  sendSessionUpdate(tabId);
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

async function sendSessionUpdate(tabId) {
  const port = panelPorts.get(tabId);
  if (!port) return;

  const session = await getSession(tabId);
  port.postMessage({
    type: ACTIONS.SESSION_UPDATED,
    tabId,
    payload: session
  });
}

function storageKey(tabId) {
  return `session:${tabId}`;
}

async function requestAuthSync(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: ACTIONS.REQUEST_AUTH_SYNC });
  } catch {
    // The active tab may not have a content script context we can message.
  }
}

async function syncAuthSession(payload) {
  if (!payload?.token || !payload?.user) {
    await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
    return;
  }

  await chrome.storage.local.set({
    [AUTH_TOKEN_KEY]: payload.token,
    [AUTH_USER_KEY]: payload.user
  });
}
