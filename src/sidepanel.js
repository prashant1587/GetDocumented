const API_BASE_URL = 'http://localhost:8080';
const WEB_APP_BASE_URL = 'http://localhost:8080';
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
const LOGIN_ENDPOINT = '/api/auth/login';
const ME_ENDPOINT = '/api/auth/me';
const DEPARTMENTS_ENDPOINT = '/api/departments';
const SAVE_ENDPOINT = '/api/documents';
const EXPORT_ENDPOINT = '/api/documents/export/pdf';
const PRESIGNED_UPLOAD_ENDPOINT = '/api/documents/uploads/presigned-url';
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';
const ACTIVE_SESSION_KEY = 'session:active';
const CAPTURE_ACROSS_TABS_KEY = 'captureAcrossTabs';
const LOG_PREFIX = '[GetDocumented:sidepanel]';

const stepsContainer = document.getElementById('steps');
const stepTemplate = document.getElementById('stepTemplate');
const documentTemplate = document.getElementById('documentTemplate');
const restartCaptureButton = document.getElementById('restartCapture');
const saveButton = document.getElementById('saveSession');
const clearButton = document.getElementById('clearSession');
const saveStatus = document.getElementById('saveStatus');
const authLoggedOut = document.getElementById('authLoggedOut');
const appShell = document.getElementById('appShell');
const launcherView = document.getElementById('launcherView');
const captureView = document.getElementById('captureView');
const documentsList = document.getElementById('documentsList');
const authUserEmail = document.getElementById('authUserEmail');
const authUserInitials = document.getElementById('authUserInitials');
const authStatus = document.getElementById('authStatus');
const openLoginButton = document.getElementById('openLoginButton');
const logoutButton = document.getElementById('logoutButton');
const settingsButton = document.getElementById('settingsButton');
const settingsPanel = document.getElementById('settingsPanel');
const captureAcrossTabsToggle = document.getElementById('captureAcrossTabsToggle');
const documentSearchInput = document.getElementById('documentSearch');
const START_CAPTURE_ATTACH_DELAY_MS = 3000;

let currentTabId;
let session = [];
let authToken = null;
let authUser = null;
let availableDepartments = [];
let availableDocuments = [];
let port = null;
let portConnected = false;
let documentSearchTerm = '';
let authSyncIntervalId = null;
let pendingAuthReturn = null;
let isCaptureMode = false;
let captureAcrossTabs = false;

init();

chrome.tabs.onActivated.addListener(() => {
  void syncCurrentTabContext();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab?.active) {
    return;
  }

  if (changeInfo.status === 'complete' || typeof changeInfo.url === 'string') {
    void syncCurrentTabContext();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void syncCurrentTabContext();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  const sessionKey = storageKey();
  if (sessionKey && changes[sessionKey]) {
    session = Array.isArray(changes[sessionKey].newValue) ? changes[sessionKey].newValue : [];
    console.debug(LOG_PREFIX, 'session storage updated', { tabId: currentTabId, count: session.length });
    renderSession();
    updateControlState();
  }

  if (changes[CAPTURE_ACROSS_TABS_KEY]) {
    captureAcrossTabs = Boolean(changes[CAPTURE_ACROSS_TABS_KEY].newValue);
    captureAcrossTabsToggle.checked = captureAcrossTabs;
  }

  if (!changes[AUTH_TOKEN_KEY] && !changes[AUTH_USER_KEY]) {
    return;
  }

  authToken = changes[AUTH_TOKEN_KEY]?.newValue ?? authToken;
  authUser = changes[AUTH_USER_KEY]?.newValue ?? authUser;

  if (typeof changes[AUTH_TOKEN_KEY]?.newValue === 'undefined') {
    authToken = null;
  }

  if (typeof changes[AUTH_USER_KEY]?.newValue === 'undefined') {
    authUser = null;
  }

  updateAuthUi();
  console.debug(LOG_PREFIX, 'auth storage updated', { authenticated: isAuthenticated(), email: authUser?.email || null });

  if (isAuthenticated()) {
    void restoreSourceTabAfterAuth();
  }

  if (isAuthenticated()) {
    void loadDepartments();
    void loadAccessibleDocuments();
  } else {
    availableDepartments = [];
    availableDocuments = [];
    updateDepartmentUi();
    renderDocuments();
  }
});

async function init() {
  const didBindTab = await syncCurrentTabContext({ force: true });

  if (!didBindTab || !currentTabId) {
    stepsContainer.innerHTML = '<div class="empty">Unable to identify active tab.</div>';
    return;
  }

  await restoreCaptureSettings();
  await restoreAuthSession();
  connectPort();
  updateAuthPolling();
}

async function syncCurrentTabContext({ force = false } = {}) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const nextTabId = activeTab?.id;

  if (!nextTabId) {
    return false;
  }

  if (!force && nextTabId === currentTabId) {
    return true;
  }

  currentTabId = nextTabId;
  if (!isCaptureMode) {
    session = [];
  }
  console.debug(LOG_PREFIX, 'syncCurrentTabContext', { currentTabId });
  renderSession();
  postPortMessage({ type: 'REQUEST_SESSION', tabId: currentTabId });

  return true;
}

openLoginButton.addEventListener('click', async () => {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const createdTab = await chrome.tabs.create({
      url: `${WEB_APP_BASE_URL}/login?extension=1`
    });
    pendingAuthReturn = {
      sourceTabId: activeTab?.id ?? null,
      sourceWindowId: activeTab?.windowId ?? null,
      authTabId: createdTab?.id ?? null
    };
    showAuthStatus('Complete login or registration in the web app. This extension will sign in automatically.', null);
  } catch (error) {
    showAuthStatus(`Unable to open the web app: ${error.message}`, 'error');
  }
});

logoutButton.addEventListener('click', async () => {
  await clearAuthSession();
  showAuthStatus('Logged out. Capture is disabled until you sign in again.', 'success');
});

settingsButton.addEventListener('click', () => {
  const nextHidden = !settingsPanel.hidden;
  settingsPanel.hidden = nextHidden;
  settingsButton.setAttribute('aria-expanded', String(!nextHidden));
});

captureAcrossTabsToggle.addEventListener('change', async (event) => {
  captureAcrossTabs = Boolean(event.target.checked);
  await chrome.storage.local.set({ [CAPTURE_ACROSS_TABS_KEY]: captureAcrossTabs });
});

document.addEventListener('click', (event) => {
  if (settingsPanel.hidden) {
    return;
  }

  if (settingsPanel.contains(event.target) || settingsButton.contains(event.target)) {
    return;
  }

  settingsPanel.hidden = true;
  settingsButton.setAttribute('aria-expanded', 'false');
});

clearButton.addEventListener('click', async () => {
  await stopCaptureSession();
  await resetCaptureSession();
  setCaptureMode(false);
});

documentSearchInput.addEventListener('input', (event) => {
  documentSearchTerm = event.target.value.trim().toLowerCase();
  renderDocuments();
});

restartCaptureButton.addEventListener('click', async () => {
  if (!isAuthenticated()) {
    showStatus('Log in to enable capture.', 'error');
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id;

  if (!tabId) {
    showStatus('Unable to identify active tab.', 'error');
    return;
  }

  setCaptureMode(true);
  await setCaptureStartingOverlay(tabId, true);
  showStatus('Starting capture...', null);

  try {
    await delay(START_CAPTURE_ATTACH_DELAY_MS);
    await syncCurrentTabContext({ force: true });

    if (!currentTabId) {
      showStatus('Unable to identify active tab.', 'error');
      return;
    }

    postPortMessage({ type: 'START_CAPTURE_SESSION', tabId: currentTabId, captureAcrossTabs });
    showStatus('Capture restarted. Your next click will become step 1.', 'success');
  } catch (error) {
    showStatus(`Unable to start capture: ${error.message}`, 'error');
  } finally {
    await setCaptureStartingOverlay(tabId, false);
  }
});

saveButton.addEventListener('click', async () => {
  if (!isAuthenticated()) {
    showStatus('Log in to save captured steps.', 'error');
    return;
  }

  if (!session.length) {
    showStatus('Capture at least one step before saving.', 'error');
    return;
  }

  saveButton.disabled = true;
  showStatus('Saving session...', null);

  try {
    const savedDocument = await saveSession(session);
    await stopCaptureSession();
    await resetCaptureSession();
    setCaptureMode(false);
    await loadAccessibleDocuments();
    await chrome.tabs.create({
      url: `${WEB_APP_BASE_URL}/documents/${savedDocument.id}?edit=1`
    });
    showStatus('Draft opened in the web editor. Review, edit, and publish from there.', 'success');
  } catch (error) {
    if (error.status === 401) {
      await clearAuthSession();
      showAuthStatus('Session expired. Log in again to continue.', 'error');
    }

    showStatus(`Unable to save: ${error.message}`, 'error');
  } finally {
    updateControlState();
  }
});

function renderSession() {
  stepsContainer.innerHTML = '';
  const filteredSession = session;

  if (!filteredSession.length) {
    stepsContainer.innerHTML = isAuthenticated()
      ? '<div class="empty">No clicks captured yet. Start clicking in the page to create documentation steps.</div>'
      : '<div class="empty">Log in to enable capture and build documentation steps.</div>';
    return;
  }

  for (const step of filteredSession) {
    stepsContainer.appendChild(createStepElement(step));
  }

  updateControlState();
}

function appendStep(step) {
  if (!step || session.some((item) => item.id === step.id)) {
    return;
  }

  session = [...session, step];

  if (stepsContainer.querySelector('.empty')) {
    stepsContainer.innerHTML = '';
  }

  stepsContainer.appendChild(createStepElement(step));
  updateControlState();
}

function createStepElement(step) {
  const fragment = stepTemplate.content.cloneNode(true);
  const article = fragment.querySelector('.step');
  article.dataset.stepId = step.id;
  fragment.querySelector('h2').textContent = step.title;
  fragment.querySelector('.meta').textContent = step.description || `Step ${step.stepNumber}`;
  fragment.querySelector('.selector').textContent = step.detail || `Step ${step.stepNumber}`;

  const image = fragment.querySelector('img');
  image.src = step.screenshot;
  image.alt = `Step ${step.stepNumber} screenshot`;

  return fragment;
}

stepsContainer.addEventListener('click', async (event) => {
  const deleteButton = event.target.closest('.step-delete-button');
  if (!deleteButton) {
    return;
  }

  const stepElement = deleteButton.closest('.step');
  const stepId = stepElement?.dataset.stepId;
  if (!stepId) {
    return;
  }

  await syncCurrentTabContext({ force: true });
  if (!currentTabId) {
    return;
  }

  postPortMessage({ type: 'DELETE_STEP', tabId: currentTabId, stepId });
});

function connectPort() {
  if (portConnected) {
    return;
  }

  try {
    port = chrome.runtime.connect({ name: 'sidepanel' });
  } catch (error) {
    showStatus(`Extension connection unavailable: ${error.message}`, 'error');
    return;
  }

  portConnected = true;

  port.onMessage.addListener((message) => {
    // Background signals that a click was blocked because the user is not authenticated
    if (message.type === 'AUTH_REQUIRED') {
      console.warn(LOG_PREFIX, 'AUTH_REQUIRED');
      showAuthStatus('Log in to enable click capture.', 'error');
      return;
    }

    if (message.type === 'STEP_CAPTURED') {
      if (message.tabId !== currentTabId) return;
      console.debug(LOG_PREFIX, 'STEP_CAPTURED', { tabId: message.tabId, stepNumber: message.payload?.stepNumber, title: message.payload?.title });
      appendStep(message.payload);
      clearTransientStatus();
      return;
    }

    if (message.type !== 'SESSION_UPDATED') return;
    if (message.tabId !== currentTabId) return;
    console.debug(LOG_PREFIX, 'SESSION_UPDATED', { tabId: message.tabId, count: message.payload?.length || 0 });
    session = message.payload;
    renderSession();
    updateControlState();
    clearTransientStatus();
  });

  port.onDisconnect.addListener(() => {
    portConnected = false;
    port = null;
  });
}

function postPortMessage(message) {
  if (!currentTabId) {
    return false;
  }

  if (!portConnected) {
    connectPort();
  }

  if (!port) {
    return false;
  }

  try {
    port.postMessage(message);
    return true;
  } catch {
    portConnected = false;
    port = null;
    return false;
  }
}

async function setCaptureStartingOverlay(tabId, visible) {
  if (typeof tabId !== 'number') {
    return;
  }

  try {
    // On first install the content script may not yet be running in this tab.
    // Inject it proactively so the overlay message always has a recipient.
    if (visible) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content.js']
        });
        // Give the freshly-injected script a tick to finish installing its listeners
        // before we fire the message at it.
        await delay(60);
      } catch {
        // Already injected or tab cannot be scripted — proceed anyway.
      }
    }

    await chrome.tabs.sendMessage(tabId, {
      type: visible ? 'SHOW_CAPTURE_ATTACHING' : 'HIDE_CAPTURE_ATTACHING'
    });
  } catch {
    // Ignore tabs that do not currently have a content script context.
  }
}

async function restoreAuthSession() {
  const stored = await chrome.storage.local.get([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
  authToken = stored[AUTH_TOKEN_KEY] || null;
  authUser = stored[AUTH_USER_KEY] || null;

  if (!authToken) {
    updateAuthUi();
    return;
  }

  try {
    const responseData = await apiFetchJson(ME_ENDPOINT);
    authUser = responseData.user;
    await persistAuthSession();
    await Promise.all([loadDepartments(), loadAccessibleDocuments()]);
    showAuthStatus(`Signed in as ${authUser.email}.`, 'success');
  } catch (error) {
    await clearAuthSession();
    showAuthStatus(`Log in to enable capture. ${error.message}`, 'error');
  }
}

async function restoreCaptureSettings() {
  const stored = await chrome.storage.local.get(CAPTURE_ACROSS_TABS_KEY);
  captureAcrossTabs = Boolean(stored[CAPTURE_ACROSS_TABS_KEY]);
  captureAcrossTabsToggle.checked = captureAcrossTabs;
}

async function persistAuthSession() {
  await chrome.storage.local.set({
    [AUTH_TOKEN_KEY]: authToken,
    [AUTH_USER_KEY]: authUser
  });
  updateAuthUi();
}

async function clearAuthSession() {
  authToken = null;
  authUser = null;
  availableDepartments = [];
  availableDocuments = [];
  pendingAuthReturn = null;
  await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
  updateAuthUi();
}

function updateAuthUi() {
  const authenticated = isAuthenticated();
  document.body.classList.toggle('authenticated', authenticated);
  authLoggedOut.hidden = authenticated;
  appShell.hidden = !authenticated;
  if (!authenticated) {
    setCaptureMode(false);
  } else {
    launcherView.hidden = isCaptureMode;
    captureView.hidden = !isCaptureMode;
  }
  authUserEmail.textContent = authenticated ? authUser?.email || 'Unknown user' : '';
  authUserInitials.textContent = authenticated ? buildUserInitials(authUser) : 'U';
  updateAuthPolling();
  updateDepartmentUi();
  updateControlState();
  renderSession();
  renderDocuments();
}

function updateControlState() {
  const authenticated = isAuthenticated();
  restartCaptureButton.disabled = !authenticated;
  clearButton.disabled = !authenticated || !isCaptureMode;
  saveButton.disabled = !authenticated || !isCaptureMode || !session.length;
}

function isAuthenticated() {
  return Boolean(authToken && authUser);
}

function buildUserInitials(user) {
  const source = user?.name?.trim() || user?.email?.trim() || 'User';
  return source.charAt(0).toUpperCase();
}

function updateAuthPolling() {
  if (isAuthenticated()) {
    if (authSyncIntervalId) {
      window.clearInterval(authSyncIntervalId);
      authSyncIntervalId = null;
    }
    return;
  }

  if (authSyncIntervalId) {
    return;
  }

  authSyncIntervalId = window.setInterval(() => {
    postPortMessage({ type: 'REQUEST_AUTH_SYNC' });
    void syncAuthFromOpenAppTabs();
  }, 1500);
}

async function syncAuthFromOpenAppTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: WEB_APP_URL_PATTERNS });

    for (const tab of tabs) {
      if (typeof tab.id !== 'number') {
        continue;
      }

      const payload = await readAuthSessionFromTab(tab.id);

      if (!payload?.token || !payload?.user) {
        continue;
      }

      const wasAuthenticated = isAuthenticated();
      authToken = payload.token;
      authUser = payload.user;
      await persistAuthSession();
      await Promise.all([loadDepartments(), loadAccessibleDocuments()]);

      if (!wasAuthenticated) {
        showAuthStatus(`Signed in as ${payload.user.email}.`, 'success');
      }

      return;
    }
  } catch {
    // Ignore polling failures and retry on the next interval.
  }
}

async function readAuthSessionFromTab(tabId) {
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

    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function saveSession(steps) {
  const uploadReadyPayload = await buildSaveDocumentPayload(steps);
  return apiFetchJson(SAVE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(uploadReadyPayload)
  });
}

async function buildSaveDocumentPayload(steps) {
  const items = [];

  for (const [index, step] of steps.entries()) {
    showStatus(`Uploading screenshot ${index + 1} of ${steps.length}...`, null);
    items.push(await uploadStepScreenshot(step, index));
  }

  return {
    title: getDocumentTitle(steps),
    sourceUrl: getDocumentSourceUrl(steps),
    departmentId: getSelectedDepartmentId(),
    status: 'draft',
    visibility: 'public',
    items
  };
}

async function loadDepartments() {
  if (!isAuthenticated()) {
    availableDepartments = [];
    updateDepartmentUi();
    return;
  }

  try {
    const responseData = await apiFetchJson(DEPARTMENTS_ENDPOINT);
    availableDepartments = Array.isArray(responseData?.departments) ? responseData.departments : [];
  } catch {
    availableDepartments = [];
  }

  updateDepartmentUi();
}

async function loadAccessibleDocuments() {
  if (!isAuthenticated()) {
    availableDocuments = [];
    renderDocuments();
    return;
  }

  try {
    const responseData = await apiFetchJson(SAVE_ENDPOINT);
    availableDocuments = Array.isArray(responseData) ? responseData : [];
  } catch {
    availableDocuments = [];
  }

  renderDocuments();
}

function buildDocumentPayload(steps) {
  return {
    title: getDocumentTitle(steps),
    sourceUrl: getDocumentSourceUrl(steps),
    items: steps.map((step, index) => ({
      title: step.title,
      description: step.direction,
      screenshot: step.screenshot,
      mimeType: parseMimeType(step.screenshot),
      fileName: buildFileName(step, index),
      position: index + 1
    }))
  };
}

async function uploadStepScreenshot(step, index) {
  const mimeType = parseMimeType(step.screenshot);
  const fileName = buildFileName(step, index);
  const uploadDescriptor = await createPresignedUpload({ mimeType, fileName });

  const uploadResponse = await fetch(uploadDescriptor.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType
    },
    body: dataUrlToBlob(step.screenshot)
  });

  if (!uploadResponse.ok) {
    throw new Error(`Screenshot upload failed with status ${uploadResponse.status}.`);
  }

  return {
    title: step.title,
    description: step.direction,
    screenshotUrl: uploadDescriptor.fileUrl,
    mimeType,
    fileName,
    position: index + 1
  };
}

async function createPresignedUpload({ mimeType, fileName }) {
  const responseData = await apiFetchJson(PRESIGNED_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ mimeType, fileName })
  });

  if (!responseData?.uploadUrl || !responseData?.fileUrl) {
    throw new Error('Backend did not return a valid upload URL response.');
  }

  return responseData;
}

async function apiFetchJson(path, init = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, withAuthHeaders(init));

  if (!response.ok) {
    const error = new Error(await parseApiError(response));
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function withAuthHeaders(init) {
  const headers = new Headers(init.headers || {});

  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`);
  }

  return {
    ...init,
    headers
  };
}

function updateDepartmentUi() {}

function setCaptureMode(active) {
  isCaptureMode = Boolean(active && isAuthenticated());
  launcherView.hidden = isCaptureMode;
  captureView.hidden = !isCaptureMode;
  updateControlState();
  renderSession();
}

async function resetCaptureSession() {
  session = [];
  renderSession();
  updateControlState();

  if (!currentTabId) {
    return;
  }

  postPortMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
}

async function stopCaptureSession() {
  if (!currentTabId) {
    return;
  }

  postPortMessage({ type: 'STOP_CAPTURE_SESSION', tabId: currentTabId });
}

function renderDocuments() {
  documentsList.innerHTML = '';

  if (!isAuthenticated()) {
    documentsList.innerHTML = '<div class="empty">Log in to view documents you can access.</div>';
    return;
  }

  const filteredDocuments = availableDocuments.filter(matchesDocumentSearch);

  if (!filteredDocuments.length) {
    documentsList.innerHTML = availableDocuments.length
      ? '<div class="empty">No documents match your search.</div>'
      : '<div class="empty">No published documents are available yet.</div>';
    return;
  }

  for (const document of filteredDocuments) {
    documentsList.appendChild(createDocumentElement(document));
  }
}

function matchesDocumentSearch(document) {
  if (!documentSearchTerm) {
    return true;
  }

  const haystack = [document.title, document.status, document.department?.name, document.sourceUrl]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(documentSearchTerm);
}

function createDocumentElement(document) {
  const fragment = documentTemplate.content.cloneNode(true);
  fragment.querySelector('h3').textContent = document.title || 'Untitled document';
  fragment.querySelector('.document-meta').textContent = [document.department?.name || 'All teams', formatStepCount(document.items)]
    .filter(Boolean)
    .join(' • ');
  fragment.querySelector('.document-date').textContent = formatDocumentDate(document.updatedAt);
  fragment.querySelector('.document-status').textContent = document.status || 'published';
  return fragment;
}

function formatStepCount(items) {
  const count = Array.isArray(items) ? items.length : 0;
  return `${count} step${count === 1 ? '' : 's'}`;
}

function formatDocumentDate(value) {
  if (!value) {
    return 'Updated recently';
  }

  try {
    return `Updated ${new Date(value).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    })}`;
  } catch {
    return 'Updated recently';
  }
}

function getSelectedDepartmentId() {
  return authUser?.departmentId || null;
}

function buildDocumentTitle(steps) {
  let host = 'captured-flow';

  if (steps[0]?.pageUrl) {
    try {
      host = new URL(steps[0].pageUrl).hostname || host;
    } catch {
      host = 'captured-flow';
    }
  }

  return `${host} Product Walkthrough – ${new Date().toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  })}`;
}

function getDocumentTitle(steps) {
  return buildDocumentTitle(steps);
}

function getDocumentSourceUrl(steps) {
  return steps[0]?.pageUrl || null;
}

function buildDocumentSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'getdocumented-walkthrough';
}

function parseMimeType(screenshot) {
  const mimeTypeMatch = screenshot.match(/^data:(.+?);base64,/);
  return mimeTypeMatch?.[1] ?? 'image/png';
}

function buildFileName(step, index) {
  const sanitizedTitle = step.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const safeTitle = sanitizedTitle || `step-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${safeTitle}.png`;
}

function dataUrlToBlob(dataUrl) {
  const [metadata, base64Data] = dataUrl.split(',');

  if (!metadata || !base64Data) {
    throw new Error('Screenshot payload is not a valid data URL.');
  }

  const mimeType = metadata.match(/^data:(.+);base64$/)?.[1] || 'image/png';
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function parseApiError(response) {
  const responseText = await response.text();

  if (!responseText) {
    return `Request failed with status ${response.status}`;
  }

  try {
    const parsed = JSON.parse(responseText);
    return parsed?.message || responseText;
  } catch {
    return responseText;
  }
}

function showStatus(message, type) {
  saveStatus.textContent = message;
  saveStatus.classList.remove('success', 'error');
  if (type) {
    saveStatus.classList.add(type);
  }
}

function showAuthStatus(message, type) {
  authStatus.textContent = message;
  authStatus.classList.remove('success', 'error');
  if (type) {
    authStatus.classList.add(type);
  }
}

function clearStatus() {
  showStatus('', null);
}

function clearTransientStatus() {
  if (saveStatus.classList.contains('success') || saveStatus.classList.contains('error')) {
    return;
  }

  clearStatus();
}

function storageKey() {
  return ACTIVE_SESSION_KEY;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function restoreSourceTabAfterAuth() {
  if (!pendingAuthReturn?.sourceTabId) {
    return;
  }

  const { sourceTabId, sourceWindowId, authTabId } = pendingAuthReturn;
  pendingAuthReturn = null;

  try {
    if (typeof sourceWindowId === 'number') {
      await chrome.windows.update(sourceWindowId, { focused: true });
    }

    await chrome.tabs.update(sourceTabId, { active: true });

    if (typeof authTabId === 'number' && authTabId !== sourceTabId) {
      await chrome.tabs.remove(authTabId);
    }
  } catch {
    // Ignore if the user closed or moved one of the tabs during auth.
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
