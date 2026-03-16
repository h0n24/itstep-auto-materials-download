# Project Instructions

- GitHub commit messages must always be written in English.
- With every code change, always increase the extension version in `manifest.json`.
- Version format must be `x.x`.
- Example progression: `0.1` -> `0.2` -> ... -> `0.9` -> `1.0`.

## Goal

Implement a Chrome extension for `https://lb.itstep.org/materials` that:

- runs from the extension `browserAction` popup
- scans the currently open `/materials` page only
- opens each visible material chip modal sequentially
- extracts the direct material link from the modal
  - supported direct domains:
    - `https://fsx1.itstep.org/api/v1/files/...`
    - `https://materials.itstep.org/content/...`
- shows the collected links in the popup
- exports the collected result as:
  - an HTML index
  - a ZIP archive grouped by material type

## Current Architecture

- `manifest.json`
  - Manifest V3
  - popup entry: `popup/popup.html`
  - service worker: `background.js`
  - content script: `shared.js` + `content-script.js`
  - offscreen export document: `offscreen.html`
- `shared.js`
  - shared constants and helpers for URL validation, text normalization, color parsing, filenames and HTML escaping
- `content-script.js`
  - scans the current materials table
  - reads row number, row title, column title, chip label and material type
  - opens modals one by one and extracts the direct FSX file URL
  - reports progress back to the background worker
- `background.js`
  - maintains singleton job state
  - persists state in `chrome.storage.session`
  - relays progress to popup
  - ensures offscreen document for exports
- `offscreen.js`
  - generates HTML index downloads
  - generates ZIP downloads using the local ZIP builder in `lib/zip.js`
- `popup/*`
  - popup UI for scan, HTML export and ZIP export

## Data Model

- `MaterialLink`
  - `id`
  - `rowNumber`
  - `rowTitle`
  - `columnTitle`
  - `chipLabel`
  - `materialType`
  - `fileUrl`
  - `sourceUrl`
- Scan result metadata
  - `subjectName`

## Page Selectors And Behavior

- Supported page:
  - exact path `https://lb.itstep.org/materials`
- Main table:
  - `table.mat-mdc-table`
- Rows:
  - `tbody tr[mat-row]`
  - fallback `tbody tr.mat-mdc-row`
- Modal:
  - `mat-dialog-container`
- Direct file link in modal:
  - `a[href]`
  - accepted targets:
    - `fsx1.itstep.org/api/v1/files/...`
    - `materials.itstep.org/content/...`
- Subject selector for export naming:
  - `lib-expanded-select[formcontrolname="id_spec"] .mat-mdc-select-min-line`
  - do not rely on the localized visible label text like `Předmět`

## Material Type Detection

Do not rely only on Angular chip classes. The real type is determined from the actual chip color.

- base material:
  - color `#02a8f4`
  - folder `Zakladni-materialy`
- supplementary material:
  - color `#9b87fa`
  - folder `Doplnkove-materialy`

Fallback:

- inspect `--mdc-chip-elevated-container-color`
- then fallback to computed `background-color`

## Export Rules

- HTML export:
  - simple standalone index with row, block title, column, chip label, type and direct link
  - filename is based on selected subject + current date
- ZIP export:
  - top-level folders:
    - `Zakladni-materialy/`
    - `Doplnkove-materialy/`
  - archive filename is based on selected subject + current date
  - filenames are built from:
    - row number
    - column title
    - chip label
  - if the server returns `Content-Disposition`, use its extension
  - duplicate paths must receive numeric suffixes
  - include `export-report.json` in the ZIP with download results and errors

## Scope And Assumptions

- V1 scans only the currently visible table with the current filters.
- V1 does not handle pagination or automated filter cycling.
- The user will see modal open/close activity in the active tab during scanning.
- The `to-be-deleted` folder is reference material only and is not a runtime dependency.
