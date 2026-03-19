const API_BASE_URL = 'http://localhost:8080';
const WEB_APP_BASE_URL = 'http://localhost:8080';
const LOGIN_ENDPOINT = '/api/auth/login';
const ME_ENDPOINT = '/api/auth/me';
const DEPARTMENTS_ENDPOINT = '/api/departments';
const SAVE_ENDPOINT = '/api/documents';
const EXPORT_ENDPOINT = '/api/documents/export/pdf';
const PRESIGNED_UPLOAD_ENDPOINT = '/api/documents/uploads/presigned-url';
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';

const stepsContainer = document.getElementById('steps');
const stepTemplate = document.getElementById('stepTemplate');
const restartCaptureButton = document.getElementById('restartCapture');
const exportButton = document.getElementById('exportPdf');
const saveButton = document.getElementById('saveSession');
const clearButton = document.getElementById('clearSession');
const saveStatus = document.getElementById('saveStatus');
const authLoggedOut = document.getElementById('authLoggedOut');
const authLoggedIn = document.getElementById('authLoggedIn');
const authUserEmail = document.getElementById('authUserEmail');
const authStatus = document.getElementById('authStatus');
const openLoginButton = document.getElementById('openLoginButton');
const logoutButton = document.getElementById('logoutButton');
const departmentPicker = document.getElementById('departmentPicker');
const saveDepartmentSelect = document.getElementById('saveDepartment');
const documentTitleInput = document.getElementById('documentTitle');
const saveVisibilitySelect = document.getElementById('saveVisibility');

let currentTabId;
let session = [];
let authToken = null;
let authUser = null;
let availableDepartments = [];
let port = null;
let portConnected = false;

init();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
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

  if (isAuthenticated()) {
    void loadDepartments();
  } else {
    availableDepartments = [];
    updateDepartmentUi();
  }
});

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = activeTab?.id;

  if (!currentTabId) {
    stepsContainer.innerHTML = '<div class="empty">Unable to identify active tab.</div>';
    return;
  }

  await restoreAuthSession();
  connectPort();
  postPortMessage({ type: 'REQUEST_SESSION', tabId: currentTabId });
}

openLoginButton.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({
      url: `${WEB_APP_BASE_URL}/extension-auth`
    });
    showAuthStatus('Complete login or registration in the web app. This extension will sign in automatically.', null);
  } catch (error) {
    showAuthStatus(`Unable to open the web app: ${error.message}`, 'error');
  }
});

logoutButton.addEventListener('click', async () => {
  await clearAuthSession();
  showAuthStatus('Logged out. Capture is disabled until you sign in again.', 'success');
});

clearButton.addEventListener('click', () => {
  if (!currentTabId) return;
  documentTitleInput.value = '';
  postPortMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
});

restartCaptureButton.addEventListener('click', () => {
  if (!isAuthenticated()) {
    showStatus('Log in to enable capture.', 'error');
    return;
  }

  if (!currentTabId) return;

  documentTitleInput.value = '';
  postPortMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
  showStatus('Capture restarted. Your next click will become step 1.', 'success');
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
    showStatus(`Saved successfully (${savedDocument.title || savedDocument.id}).`, 'success');
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

exportButton.addEventListener('click', async () => {
  if (!isAuthenticated()) {
    showStatus('Log in to export captured steps.', 'error');
    return;
  }

  if (!session.length) {
    showStatus('Capture at least one step before exporting.', 'error');
    return;
  }

  exportButton.disabled = true;
  showStatus('Exporting PDF...', null);

  try {
    const pdfBlob = await exportSession(session);
    downloadBlob(pdfBlob, `${buildDocumentSlug(getDocumentTitle(session))}.pdf`);
    showStatus('Export finished.', 'success');
  } catch (error) {
    if (error.status === 401) {
      await clearAuthSession();
      showAuthStatus('Session expired. Log in again to continue.', 'error');
    }

    showStatus(`Unable to export: ${error.message}`, 'error');
  } finally {
    updateControlState();
  }
});

function renderSession() {
  stepsContainer.innerHTML = '';

  if (!session.length) {
    stepsContainer.innerHTML = isAuthenticated()
      ? '<div class="empty">No clicks captured yet. Start clicking in the page to create documentation steps.</div>'
      : '<div class="empty">Log in to enable capture and build documentation steps.</div>';
    return;
  }

  for (const step of session) {
    const fragment = stepTemplate.content.cloneNode(true);
    fragment.querySelector('h2').textContent = `Step ${step.stepNumber}: ${step.title}`;
    fragment.querySelector('.meta').textContent = `Click on: ${step.title}`;

    const image = fragment.querySelector('img');
    image.src = step.screenshot;
    image.alt = `Step ${step.stepNumber} screenshot`;

    stepsContainer.appendChild(fragment);
  }
}

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
      showAuthStatus('Log in to enable click capture.', 'error');
      return;
    }

    if (message.type !== 'SESSION_UPDATED') return;
    if (message.tabId !== currentTabId) return;
    session = message.payload;
    renderSession();
    clearStatus();
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
    await loadDepartments();
    showAuthStatus(`Signed in as ${authUser.email}.`, 'success');
  } catch (error) {
    await clearAuthSession();
    showAuthStatus(`Log in to enable capture. ${error.message}`, 'error');
  }
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
  await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
  updateAuthUi();
}

function updateAuthUi() {
  const authenticated = isAuthenticated();
  authLoggedOut.hidden = authenticated;
  authLoggedIn.hidden = !authenticated;
  authUserEmail.textContent = authenticated ? authUser?.email || 'Unknown user' : '';
  updateDepartmentUi();
  updateControlState();
  renderSession();
}

function updateControlState() {
  const authenticated = isAuthenticated();
  restartCaptureButton.disabled = !authenticated;
  clearButton.disabled = !authenticated;
  saveButton.disabled = !authenticated;
  exportButton.disabled = !authenticated;
}

function isAuthenticated() {
  return Boolean(authToken && authUser);
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

async function exportSession(steps) {
  return apiFetchBlob(EXPORT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildDocumentPayload(steps))
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
    visibility: saveVisibilitySelect?.value || 'public',
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

async function apiFetchBlob(path, init = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, withAuthHeaders(init));

  if (!response.ok) {
    const error = new Error(await parseApiError(response));
    error.status = response.status;
    throw error;
  }

  return response.blob();
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

function updateDepartmentUi() {
  const canChooseDepartment = isAuthenticated() && !authUser?.departmentId;
  departmentPicker.hidden = !canChooseDepartment;

  if (!canChooseDepartment) {
    saveDepartmentSelect.innerHTML = '';
    return;
  }

  const options = availableDepartments.length
    ? availableDepartments
    : [{ id: '', name: 'Common', isCommon: true }];

  saveDepartmentSelect.innerHTML = options
    .map(
      (department) =>
        `<option value="${department.id || ''}">${escapeHtml(department.name || 'Common')}${department.isCommon ? ' (Common)' : ''}</option>`
    )
    .join('');
}

function getSelectedDepartmentId() {
  if (!isAuthenticated()) {
    return null;
  }

  if (authUser?.departmentId) {
    return authUser.departmentId;
  }

  return saveDepartmentSelect.value || null;
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
  return documentTitleInput.value.trim() || buildDocumentTitle(steps);
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

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
