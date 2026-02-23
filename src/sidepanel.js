const API_BASE_URL = 'http://localhost:3000';
const SAVE_ENDPOINT = '/api/documents';

const port = chrome.runtime.connect({ name: 'sidepanel' });
const stepsContainer = document.getElementById('steps');
const stepTemplate = document.getElementById('stepTemplate');
const startNewCaptureButton = document.getElementById('startNewCapture');
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

startNewCaptureButton.addEventListener('click', () => {
  if (!currentTabId) return;

  port.postMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
  showStatus('Started a new capture. Your next click will create step 1.', 'success');
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
  if (!session.length) return;

  const reportHtml = buildPrintableReport(session);
  const reportBlob = new Blob([reportHtml], { type: 'text/html' });
  const reportUrl = URL.createObjectURL(reportBlob);

  await chrome.tabs.create({ url: reportUrl });
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
  const documentTitle = buildDocumentTitle(steps);
  const payload = {
    title: documentTitle,
    items: steps.map((step, index) => ({
      title: step.title,
      description: step.direction,
      screenshot: step.screenshot,
      mimeType: parseMimeType(step.screenshot),
      fileName: buildFileName(step, index),
      position: index + 1
    }))
  };

  const response = await fetch(`${API_BASE_URL}${SAVE_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
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

function buildPrintableReport(steps) {
  const cards = steps
    .map(
      (step) => `
      <section class="card">
        <h2>Step ${step.stepNumber}: ${escapeHtml(step.title)}</h2>
        <p><strong>Direction:</strong> ${escapeHtml(step.direction)}</p>
        <p><strong>Selector:</strong> <code>${escapeHtml(step.selector)}</code></p>
        <img src="${step.screenshot}" alt="Step ${step.stepNumber} screenshot" />
      </section>
    `
    )
    .join('');

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>GetDocumented Walkthrough</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
      h1 { margin-bottom: 0.2rem; }
      p.subtitle { color: #444; margin-top: 0; }
      .card { border: 1px solid #ccc; border-radius: 12px; padding: 14px; margin-bottom: 16px; break-inside: avoid; }
      img { width: 100%; border: 1px solid #ddd; border-radius: 8px; }
      code { background: #f3f4f6; padding: 2px 4px; border-radius: 4px; }
      @media print {
        .print-tip { display: none; }
        .card { page-break-inside: avoid; }
      }
    </style>
  </head>
  <body>
    <h1>GetDocumented Walkthrough</h1>
    <p class="subtitle">${steps.length} captured click steps</p>
    <p class="print-tip">Use your browser print dialog and choose <strong>Save as PDF</strong>.</p>
    ${cards}
    <script>
      setTimeout(() => window.print(), 500);
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
