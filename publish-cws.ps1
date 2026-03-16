[CmdletBinding()]
param(
  [string]$PackagePath = "",
  [string]$PublisherId = $env:CWS_PUBLISHER_ID,
  [string]$ExtensionId = $env:CWS_EXTENSION_ID,
  [string]$CredentialFile = "",
  [string]$TokenFile = "",
  [switch]$Publish,
  [switch]$DryRun,
  [string]$ServiceAccountEmail = $env:CWS_SERVICE_ACCOUNT_EMAIL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $PackagePath) {
  $PackagePath = Join-Path $scriptRoot "chrome-web-store\it-step-materials-downloader-latest.zip"
}

if (-not $CredentialFile) {
  $CredentialFile = Join-Path $scriptRoot "cws-credentials.local.json"
}

if (-not $TokenFile) {
  $TokenFile = Join-Path $scriptRoot "cws-token.local.json"
}

function Get-OAuthClientConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  $json = Get-Content -Raw $Path | ConvertFrom-Json
  $clientSection = $null
  $clientType = ""

  $hasWeb = [bool]$json.PSObject.Properties["web"]
  $hasInstalled = [bool]$json.PSObject.Properties["installed"]

  if ($hasWeb) {
    $clientSection = $json.web
    $clientType = "web"
  }
  elseif ($hasInstalled) {
    $clientSection = $json.installed
    $clientType = "installed"
  }
  else {
    throw "Credential file must contain either a 'web' or 'installed' section."
  }

  if (-not $clientSection.client_id) {
    throw "Credential file is missing client_id."
  }
  if (-not $clientSection.token_uri) {
    throw "Credential file is missing token_uri."
  }

  $hasClientSecret = [bool]$clientSection.PSObject.Properties["client_secret"]

  if ($clientType -eq "web" -and (-not $hasClientSecret -or -not $clientSection.client_secret)) {
    throw "Web OAuth client JSON must contain client_secret."
  }

  return [ordered]@{
    type = $clientType
    client_id = [string]$clientSection.client_id
    client_secret = if ($hasClientSecret -and $clientSection.client_secret) { [string]$clientSection.client_secret } else { "" }
    token_uri = [string]$clientSection.token_uri
  }
}

function Get-TokenFileData {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  return Get-Content -Raw $Path | ConvertFrom-Json
}

function Request-AccessTokenFromRefreshToken {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ClientId,
    [Parameter(Mandatory = $true)]
    [string]$RefreshToken,
    [Parameter(Mandatory = $true)]
    [string]$TokenUri,
    [string]$ClientSecret = ""
  )

  $body = @{
    client_id = $ClientId
    refresh_token = $RefreshToken
    grant_type = "refresh_token"
  }

  if ($ClientSecret) {
    $body.client_secret = $ClientSecret
  }

  $tokenResponse = Invoke-RestMethod -Method Post -Uri $TokenUri -Body $body

  if (-not $tokenResponse.access_token) {
    throw "OAuth token exchange succeeded without an access token."
  }

  return [string]$tokenResponse.access_token
}

function Get-AccessToken {
  if ($env:CWS_ACCESS_TOKEN) {
    return [ordered]@{
      token = $env:CWS_ACCESS_TOKEN
      authMode = "env-access-token"
    }
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

    return [ordered]@{
      token = $token.Trim()
      authMode = "service-account"
    }
  }

  $clientConfig = Get-OAuthClientConfig -Path $CredentialFile
  $tokenFileData = Get-TokenFileData -Path $TokenFile

  if ($clientConfig -and $tokenFileData -and $tokenFileData.refresh_token) {
    $tokenUri = if ($tokenFileData.token_uri) { [string]$tokenFileData.token_uri } else { [string]$clientConfig.token_uri }
    return [ordered]@{
      token = Request-AccessTokenFromRefreshToken `
        -ClientId $clientConfig.client_id `
        -ClientSecret $clientConfig.client_secret `
        -RefreshToken ([string]$tokenFileData.refresh_token) `
        -TokenUri $tokenUri
      authMode = "credentials-file+token-file"
    }
  }

  if ($env:CWS_CLIENT_ID -and $env:CWS_REFRESH_TOKEN) {
    $tokenUri = if ($env:CWS_TOKEN_URI) { $env:CWS_TOKEN_URI } else { "https://oauth2.googleapis.com/token" }
    return [ordered]@{
      token = Request-AccessTokenFromRefreshToken `
        -ClientId $env:CWS_CLIENT_ID `
        -ClientSecret $env:CWS_CLIENT_SECRET `
        -RefreshToken $env:CWS_REFRESH_TOKEN `
        -TokenUri $tokenUri
      authMode = "env-refresh-token"
    }
  }

  if ($clientConfig) {
    throw "Found cws-credentials.local.json, but no refresh token is available. Run .\authorize-cws.ps1 first."
  }

  throw "Set CWS_ACCESS_TOKEN, or prepare cws-credentials.local.json + cws-token.local.json, or use CWS_CLIENT_ID/CWS_REFRESH_TOKEN, or CWS_SERVICE_ACCOUNT_EMAIL."
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
  $authPreview = "unresolved"
  try {
    $authPreview = (Get-AccessToken).authMode
  }
  catch {
    $authPreview = "error: " + $_.Exception.Message
  }

  [ordered]@{
    packagePath = $PackagePath
    packageSizeBytes = (Get-Item $PackagePath).Length
    credentialFile = $CredentialFile
    credentialFileExists = (Test-Path $CredentialFile)
    tokenFile = $TokenFile
    tokenFileExists = (Test-Path $TokenFile)
    uploadUri = $uploadUri
    publishUri = $publishUri
    authMode = $authPreview
    willPublish = [bool]$Publish
  } | ConvertTo-Json -Depth 4
  exit 0
}

$accessTokenInfo = Get-AccessToken
$headers = @{
  Authorization = "Bearer " + $accessTokenInfo.token
}

$uploadResponse = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -InFile $PackagePath -ContentType "application/octet-stream"
$result = [ordered]@{
  authMode = $accessTokenInfo.authMode
  upload = $uploadResponse
}

if ($Publish) {
  $publishResponse = Invoke-RestMethod -Method Post -Uri $publishUri -Headers $headers
  $result.publish = $publishResponse
}

$result | ConvertTo-Json -Depth 10
