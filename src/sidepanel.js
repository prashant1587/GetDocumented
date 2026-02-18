const port = chrome.runtime.connect({ name: 'sidepanel' });
const stepsContainer = document.getElementById('steps');
const stepTemplate = document.getElementById('stepTemplate');
const exportButton = document.getElementById('exportPdf');
const clearButton = document.getElementById('clearSession');

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
});

clearButton.addEventListener('click', () => {
  if (!currentTabId) return;
  port.postMessage({ type: 'CLEAR_SESSION', tabId: currentTabId });
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
