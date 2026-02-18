# GetDocumented

Chrome extension to build visual documentation by clicking through a page.

## Features

- Open a sidebar from the extension action button.
- Capture every page click as a documented step.
- Store the click title, selector, location direction, and screenshot.
- Review all captured steps in order directly in the sidebar.
- Export the full sequence to a print-ready report and save as PDF.

## How it works

1. Click the extension icon to open the GetDocumented side panel.
2. Click through the target web page.
3. Each click sends metadata from the content script, and the background worker captures a screenshot.
4. The side panel updates in real time with each step.
5. Select **Export to PDF** to open a print-ready report, then choose **Save as PDF** in the browser print dialog.

## Install locally

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.

## Files

- `manifest.json` – extension configuration.
- `src/content.js` – click listener and metadata extraction.
- `src/background.js` – screenshot capture and state storage.
- `src/sidepanel.*` – sidebar UI and report export.
