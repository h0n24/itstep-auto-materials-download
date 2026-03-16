[CmdletBinding()]
param(
  [string]$CredentialFile = "",
  [string]$TokenFile = "",
  [string]$RedirectUri = "http://127.0.0.1:8765/",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $CredentialFile) {
  $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $CredentialFile = Join-Path $scriptRoot "_cws-credentials.json"
}

if (-not $TokenFile) {
  $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $TokenFile = Join-Path $scriptRoot "_cws-token.json"
}

function ConvertTo-Base64Url {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes
  )

  return [Convert]::ToBase64String($Bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function New-CodeVerifier {
  $bytes = New-Object byte[] 64
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ConvertTo-Base64Url -Bytes $bytes
}

function Get-InstalledCredentials {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Credential file not found: $Path"
  }

  $json = Get-Content -Raw $Path | ConvertFrom-Json
  if (-not $json.installed) {
    throw "Credential file must contain an 'installed' section."
  }

  $installed = $json.installed
  if (-not $installed.client_id) {
    throw "Credential file is missing installed.client_id."
  }
  if (-not $installed.auth_uri) {
    throw "Credential file is missing installed.auth_uri."
  }
  if (-not $installed.token_uri) {
    throw "Credential file is missing installed.token_uri."
  }

  return $installed
}

$credentials = Get-InstalledCredentials -Path $CredentialFile
$codeVerifier = New-CodeVerifier
$challengeBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::ASCII.GetBytes($codeVerifier))
$codeChallenge = ConvertTo-Base64Url -Bytes $challengeBytes
$state = [Guid]::NewGuid().ToString("N")
$scope = [Uri]::EscapeDataString("https://www.googleapis.com/auth/chromewebstore")
$escapedRedirectUri = [Uri]::EscapeDataString($RedirectUri)
$escapedClientId = [Uri]::EscapeDataString([string]$credentials.client_id)
$escapedState = [Uri]::EscapeDataString($state)
$escapedChallenge = [Uri]::EscapeDataString($codeChallenge)
$authUrl = "{0}?client_id={1}&redirect_uri={2}&response_type=code&scope={3}&access_type=offline&prompt=consent&state={4}&code_challenge={5}&code_challenge_method=S256" -f `
  $credentials.auth_uri, $escapedClientId, $escapedRedirectUri, $scope, $escapedState, $escapedChallenge

if ($DryRun) {
  [ordered]@{
    credentialFile = $CredentialFile
    tokenFile = $TokenFile
    redirectUri = $RedirectUri
    authUrl = $authUrl
  } | ConvertTo-Json -Depth 4
  exit 0
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($RedirectUri)
$listener.Start()

try {
  Start-Process $authUrl | Out-Null
  $context = $listener.GetContext()
  $request = $context.Request
  $response = $context.Response

  $queryState = $request.QueryString["state"]
  $authCode = $request.QueryString["code"]
  $authError = $request.QueryString["error"]

  $responseText = if ($authError) {
    "Authorization failed. You can close this window."
  } else {
    "Authorization completed. You can close this window."
  }

  $buffer = [System.Text.Encoding]::UTF8.GetBytes($responseText)
  $response.ContentType = "text/plain; charset=utf-8"
  $response.ContentLength64 = $buffer.Length
  $response.OutputStream.Write($buffer, 0, $buffer.Length)
  $response.OutputStream.Close()

  if ($authError) {
    throw "OAuth authorization failed: $authError"
  }

  if (-not $authCode) {
    throw "OAuth authorization did not return a code."
  }

  if ($queryState -ne $state) {
    throw "OAuth state validation failed."
  }

  $tokenResponse = Invoke-RestMethod -Method Post -Uri $credentials.token_uri -ContentType "application/x-www-form-urlencoded" -Body @{
    client_id = [string]$credentials.client_id
    grant_type = "authorization_code"
    code = $authCode
    redirect_uri = $RedirectUri
    code_verifier = $codeVerifier
  }

  if (-not $tokenResponse.refresh_token) {
    throw "OAuth token response did not include a refresh token."
  }

  $tokenData = [ordered]@{
    client_id = [string]$credentials.client_id
    token_uri = [string]$credentials.token_uri
    refresh_token = [string]$tokenResponse.refresh_token
    scope = [string]$tokenResponse.scope
    created_at = (Get-Date).ToString("o")
  }

  $tokenData | ConvertTo-Json -Depth 4 | Set-Content -Path $TokenFile -Encoding UTF8
  $tokenData | ConvertTo-Json -Depth 4
}
finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
