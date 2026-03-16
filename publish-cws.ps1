[CmdletBinding()]
param(
  [string]$PackagePath = "",
  [string]$PublisherId = $env:CWS_PUBLISHER_ID,
  [string]$ExtensionId = $env:CWS_EXTENSION_ID,
  [switch]$Publish,
  [switch]$DryRun,
  [string]$ServiceAccountEmail = $env:CWS_SERVICE_ACCOUNT_EMAIL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $PackagePath) {
  $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $PackagePath = Join-Path $scriptRoot "chrome-web-store\it-step-materials-downloader-latest.zip"
}

function Get-AccessToken {
  if ($env:CWS_ACCESS_TOKEN) {
    return $env:CWS_ACCESS_TOKEN
  }

  if ($ServiceAccountEmail) {
    $gcloudCommand = Get-Command gcloud -ErrorAction SilentlyContinue
    if (-not $gcloudCommand) {
      throw "gcloud is required when CWS_SERVICE_ACCOUNT_EMAIL is used."
    }

    $gcloudArgs = @(
      "auth",
      "print-access-token",
      "--impersonate-service-account=$ServiceAccountEmail",
      "--scopes=https://www.googleapis.com/auth/chromewebstore"
    )
    $token = & $gcloudCommand.Source @gcloudArgs
    if (-not $token) {
      throw "Failed to get an access token from gcloud."
    }
    return $token.Trim()
  }

  if ($env:CWS_CLIENT_ID -and $env:CWS_CLIENT_SECRET -and $env:CWS_REFRESH_TOKEN) {
    $tokenResponse = Invoke-RestMethod -Method Post -Uri "https://oauth2.googleapis.com/token" -Body @{
      client_id = $env:CWS_CLIENT_ID
      client_secret = $env:CWS_CLIENT_SECRET
      refresh_token = $env:CWS_REFRESH_TOKEN
      grant_type = "refresh_token"
    }

    if (-not $tokenResponse.access_token) {
      throw "OAuth token exchange succeeded without an access token."
    }

    return [string]$tokenResponse.access_token
  }

  throw "Set CWS_ACCESS_TOKEN, or CWS_CLIENT_ID/CWS_CLIENT_SECRET/CWS_REFRESH_TOKEN, or CWS_SERVICE_ACCOUNT_EMAIL."
}

if (-not (Test-Path $PackagePath)) {
  throw "Package not found: $PackagePath"
}

if (-not $PublisherId) {
  throw "PublisherId is required. Set -PublisherId or CWS_PUBLISHER_ID."
}

if (-not $ExtensionId) {
  throw "ExtensionId is required. Set -ExtensionId or CWS_EXTENSION_ID."
}

$uploadUri = "https://chromewebstore.googleapis.com/upload/v2/publishers/{0}/items/{1}:upload" -f $PublisherId, $ExtensionId
$publishUri = "https://chromewebstore.googleapis.com/v2/publishers/{0}/items/{1}:publish" -f $PublisherId, $ExtensionId

if ($DryRun) {
  [ordered]@{
    packagePath = $PackagePath
    packageSizeBytes = (Get-Item $PackagePath).Length
    uploadUri = $uploadUri
    publishUri = $publishUri
    willPublish = [bool]$Publish
  } | ConvertTo-Json -Depth 4
  exit 0
}

$accessToken = Get-AccessToken
$headers = @{
  Authorization = "Bearer $accessToken"
}

$uploadResponse = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -InFile $PackagePath -ContentType "application/octet-stream"
$result = [ordered]@{
  upload = $uploadResponse
}

if ($Publish) {
  $publishResponse = Invoke-RestMethod -Method Post -Uri $publishUri -Headers $headers
  $result.publish = $publishResponse
}

$result | ConvertTo-Json -Depth 10
