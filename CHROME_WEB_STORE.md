# Chrome Web Store Flow

## Build the upload package

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-cws-package.ps1
```

This creates:

- `chrome-web-store/it-step-materials-downloader-<version>.zip`
- `chrome-web-store/it-step-materials-downloader-latest.zip`
- `chrome-web-store/package-info.json`

Use `it-step-materials-downloader-latest.zip` for the manual update in the Chrome Web Store dashboard.

## API upload

Chrome Web Store supports direct upload from the local machine through the official API.

Dry run:

```powershell
powershell -ExecutionPolicy Bypass -File .\publish-cws.ps1 `
  -DryRun `
  -PublisherId "<publisher-id>" `
  -ExtensionId "<extension-id>"
```

Upload only:

```powershell
$env:CWS_CLIENT_ID = "..."
$env:CWS_CLIENT_SECRET = "..."
$env:CWS_REFRESH_TOKEN = "..."
$env:CWS_PUBLISHER_ID = "..."
$env:CWS_EXTENSION_ID = "..."

powershell -ExecutionPolicy Bypass -File .\publish-cws.ps1
```

Upload and publish:

```powershell
powershell -ExecutionPolicy Bypass -File .\publish-cws.ps1 -Publish
```

## Supported auth modes

- `CWS_ACCESS_TOKEN`
- `CWS_CLIENT_ID` + `CWS_CLIENT_SECRET` + `CWS_REFRESH_TOKEN`
- `CWS_SERVICE_ACCOUNT_EMAIL` with local `gcloud` installed

## Recommended local routine

1. Make the code change.
2. Increase `manifest.json` version.
3. Run `build-cws-package.ps1`.
4. Upload `chrome-web-store/it-step-materials-downloader-latest.zip` manually, or call `publish-cws.ps1`.
