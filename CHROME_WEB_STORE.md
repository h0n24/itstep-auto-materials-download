# Chrome Web Store Flow

## Build the upload package

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-cws-package.ps1
```

This creates:

- `assets/icon-128.png` can be used directly for the Chrome Web Store listing assets
- `chrome-web-store/it-step-materials-downloader-<version>.zip`
- `chrome-web-store/it-step-materials-downloader-latest.zip`
- `chrome-web-store/package-info.json`

Use `it-step-materials-downloader-latest.zip` for the manual update in the Chrome Web Store dashboard.

## API upload

Chrome Web Store supports direct upload from the local machine through the official API.

## Local OAuth setup with `cws-credentials.local.json`

Place your Google OAuth client JSON at:

```text
cws-credentials.local.json
```

Recommended setup:

- Create the OAuth client in Google Cloud as `Web application`
- Add this exact redirect URI:

```text
http://127.0.0.1:8765/
```

- Then download the JSON and save it as `cws-credentials.local.json`

Then authorize once:

```powershell
powershell -ExecutionPolicy Bypass -File .\authorize-cws.ps1
```

This opens the Google login page in the browser and stores the refresh token in:

```text
cws-token.local.json
```

Both files are ignored by git.

Dry run:

```powershell
powershell -ExecutionPolicy Bypass -File .\publish-cws.ps1 `
  -DryRun `
  -PublisherId "<publisher-id>" `
  -ExtensionId "<extension-id>"
```

Upload only:

```powershell
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
- `_cws-credentials.json` + `_cws-token.json`
- `CWS_CLIENT_ID` + `CWS_CLIENT_SECRET` + `CWS_REFRESH_TOKEN`
- `CWS_SERVICE_ACCOUNT_EMAIL` with local `gcloud` installed

## Recommended local routine

1. Make the code change.
2. Increase `manifest.json` version.
3. Run `build-cws-package.ps1`.
4. If this machine is not authorized yet, run `authorize-cws.ps1` once.
5. Upload `chrome-web-store/it-step-materials-downloader-latest.zip` manually, or call `publish-cws.ps1`.
