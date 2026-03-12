const API_BASE_URL = 'http://localhost:3000';
const SAVE_ENDPOINT = '/api/documents';
const EXPORT_ENDPOINT = '/api/documents/export/pdf';

const port = chrome.runtime.connect({ name: 'sidepanel' });
const stepsContainer = document.getElementById('steps');
const stepTemplate = document.getElementById('stepTemplate');
const restartCaptureButton = document.getElementById('restartCapture');
const exportButton = document.getElementById('exportPdf');
const saveButton = document.getElementById('saveSession');
const clearButton = document.getElementById('clearSession');
const saveStatus = document.getElementById('saveStatus');

let currentTabId;
let session = [];

init();

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = activeTab?.id;

  if (!currentTabId) {
    stepsContainer.innerHTML = '<div class="empty">Unable to identify active tab.</div>';
    return;
  }

  port.postMessage({ type: 'REQUEST_SESSION', tabId: currentTabId });
}

port.onMessage.addListener((message) => {
  if (message.type !== 'SESSION_UPDATED') return;
  if (message.tabId !== currentTabId) return;
  session = message.payload;
  renderSession();
  clearStatus();
});

clearButton.addEventListener('click', () => {
  if (!currentTabId) return;
  port.postMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
});

restartCaptureButton.addEventListener('click', () => {
  if (!currentTabId) return;

  port.postMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
  showStatus('Capture restarted. Your next click will become step 1.', 'success');
});

saveButton.addEventListener('click', async () => {
  if (!session.length) {
    showStatus('Capture at least one step before saving.', 'error');
    return;
  }

  saveButton.disabled = true;
  showStatus('Saving session...', null);

  try {
    const savedDocument = await saveSession(session);
    showStatus(`Saved successfully (${savedDocument.id}).`, 'success');
  } catch (error) {
    showStatus(`Unable to save: ${error.message}`, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

exportButton.addEventListener('click', async () => {
  if (!session.length) {
    showStatus('Capture at least one step before exporting.', 'error');
    return;
  }

  exportButton.disabled = true;
  showStatus('Exporting PDF...', null);

  try {
    const pdfBlob = await exportSession(session);
    downloadBlob(pdfBlob, `${buildDocumentSlug(session)}.pdf`);
    showStatus('Export finished.', 'success');
  } catch (error) {
    showStatus(`Unable to export: ${error.message}`, 'error');
  } finally {
    exportButton.disabled = false;
  }
});

function renderSession() {
  stepsContainer.innerHTML = '';

  if (!session.length) {
    stepsContainer.innerHTML =
      '<div class="empty">No clicks captured yet. Start clicking in the page to create documentation steps.</div>';
    return;
  }

  for (const step of session) {
    const fragment = stepTemplate.content.cloneNode(true);
    fragment.querySelector('h2').textContent = `Step ${step.stepNumber}: ${step.title}`;
    fragment.querySelector('.meta').textContent = `Direction: ${step.direction} • Click: (${step.clickPosition.x}, ${step.clickPosition.y})`;
    fragment.querySelector('.selector').textContent = step.selector;

    const image = fragment.querySelector('img');
    image.src = step.screenshot;
    image.alt = `Step ${step.stepNumber} screenshot`;

    stepsContainer.appendChild(fragment);
  }
}

async function saveSession(steps) {
  const response = await fetch(`${API_BASE_URL}${SAVE_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildDocumentPayload(steps))
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed with status ${response.status}`);
  }

  const responseData = await response.json();

  if (!responseData?.id) {
    throw new Error('Backend did not return a valid document response.');
  }

  return responseData;
}

async function exportSession(steps) {
  const response = await fetch(`${API_BASE_URL}${EXPORT_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildDocumentPayload(steps))
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed with status ${response.status}`);
  }

  return response.blob();
}

function buildDocumentPayload(steps) {
  return {
    title: buildDocumentTitle(steps),
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

function buildDocumentTitle(steps) {
  let host = 'captured-flow';

  if (steps[0]?.pageUrl) {
    try {
      host = new URL(steps[0].pageUrl).hostname || host;
    } catch {
      host = 'captured-flow';
    }
  }

  return `${host} walkthrough (${new Date().toISOString()})`;
}

function buildDocumentSlug(steps) {
  return buildDocumentTitle(steps)
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

function showStatus(message, type) {
  saveStatus.textContent = message;
  saveStatus.classList.remove('success', 'error');
  if (type) {
    saveStatus.classList.add(type);
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
