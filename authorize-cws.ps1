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
  $CredentialFile = Join-Path $scriptRoot "cws-credentials.local.json"
}

if (-not $TokenFile) {
  $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
  $TokenFile = Join-Path $scriptRoot "cws-token.local.json"
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

function Get-OAuthClientConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$RequestedRedirectUri
  )

  if (-not (Test-Path $Path)) {
    throw "Credential file not found: $Path"
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
  if (-not $clientSection.auth_uri) {
    throw "Credential file is missing auth_uri."
  }
  if (-not $clientSection.token_uri) {
    throw "Credential file is missing token_uri."
  }

  $redirectUris = @()
  $hasRedirectUris = [bool]$clientSection.PSObject.Properties["redirect_uris"]
  $hasClientSecret = [bool]$clientSection.PSObject.Properties["client_secret"]
  if ($hasRedirectUris) {
    $redirectUris = @($clientSection.redirect_uris | ForEach-Object { [string]$_ })
  }

  if ($clientType -eq "web") {
    if (-not $hasClientSecret -or -not $clientSection.client_secret) {
      throw "Web OAuth client JSON must contain client_secret."
    }
    if (-not $redirectUris.Count) {
      throw "Web OAuth client JSON must contain redirect_uris."
    }
    if ($redirectUris -notcontains $RequestedRedirectUri) {
      throw "The requested redirect URI '$RequestedRedirectUri' is not listed in redirect_uris. Add it in Google Cloud Console or pass a matching -RedirectUri."
    }
  }

  if ($clientType -eq "installed" -and -not $redirectUris.Count -and -not $hasClientSecret) {
    throw "This installed client JSON looks incomplete for this local flow. Create a new OAuth client in Google Cloud as either 'Desktop app' or 'Web application', then download the JSON again."
  }

  return [ordered]@{
    type = $clientType
    client_id = [string]$clientSection.client_id
    client_secret = if ($hasClientSecret -and $clientSection.client_secret) { [string]$clientSection.client_secret } else { "" }
    auth_uri = [string]$clientSection.auth_uri
    token_uri = [string]$clientSection.token_uri
    redirect_uri = $RequestedRedirectUri
    redirect_uris = $redirectUris
  }
}

$clientConfig = Get-OAuthClientConfig -Path $CredentialFile -RequestedRedirectUri $RedirectUri
$codeVerifier = New-CodeVerifier
$challengeBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::ASCII.GetBytes($codeVerifier))
$codeChallenge = ConvertTo-Base64Url -Bytes $challengeBytes
$state = [Guid]::NewGuid().ToString("N")
$scope = [Uri]::EscapeDataString("https://www.googleapis.com/auth/chromewebstore")
$escapedRedirectUri = [Uri]::EscapeDataString($clientConfig.redirect_uri)
$escapedClientId = [Uri]::EscapeDataString($clientConfig.client_id)
$escapedState = [Uri]::EscapeDataString($state)
$escapedChallenge = [Uri]::EscapeDataString($codeChallenge)
$authUrl = "{0}?client_id={1}&redirect_uri={2}&response_type=code&scope={3}&access_type=offline&prompt=consent&state={4}&code_challenge={5}&code_challenge_method=S256" -f `
  $clientConfig.auth_uri, $escapedClientId, $escapedRedirectUri, $scope, $escapedState, $escapedChallenge

if ($DryRun) {
  [ordered]@{
    credentialFile = $CredentialFile
    clientType = $clientConfig.type
    tokenFile = $TokenFile
    redirectUri = $clientConfig.redirect_uri
    authUrl = $authUrl
  } | ConvertTo-Json -Depth 4
  exit 0
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($clientConfig.redirect_uri)
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

  $tokenBody = @{
    client_id = $clientConfig.client_id
    grant_type = "authorization_code"
    code = $authCode
    redirect_uri = $clientConfig.redirect_uri
    code_verifier = $codeVerifier
  }

  if ($clientConfig.client_secret) {
    $tokenBody.client_secret = $clientConfig.client_secret
  }

  $tokenResponse = Invoke-RestMethod -Method Post -Uri $clientConfig.token_uri -ContentType "application/x-www-form-urlencoded" -Body $tokenBody

  if (-not $tokenResponse.refresh_token) {
    throw "OAuth token response did not include a refresh token."
  }

  $tokenData = [ordered]@{
    client_type = $clientConfig.type
    client_id = $clientConfig.client_id
    token_uri = $clientConfig.token_uri
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
