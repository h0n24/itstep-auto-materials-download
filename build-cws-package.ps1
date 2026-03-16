[CmdletBinding()]
param(
  [string]$RootDir = "",
  [string]$OutputDir = "",
  [string]$StableFileName = "it-step-materials-downloader-latest.zip"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RootDir) {
  $RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

if (-not $OutputDir) {
  $OutputDir = Join-Path $RootDir "chrome-web-store"
}

function Copy-PackageItem {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRoot,
    [Parameter(Mandatory = $true)]
    [string]$StageRoot,
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $sourcePath = Join-Path $SourceRoot $RelativePath
  if (-not (Test-Path $sourcePath)) {
    throw "Missing package input: $RelativePath"
  }

  $destinationPath = Join-Path $StageRoot $RelativePath
  $destinationParent = Split-Path -Parent $destinationPath
  if ($destinationParent -and -not (Test-Path $destinationParent)) {
    New-Item -ItemType Directory -Path $destinationParent | Out-Null
  }

  if (Test-Path $sourcePath -PathType Container) {
    Copy-Item -Path $sourcePath -Destination $destinationPath -Recurse -Force
    return
  }

  Copy-Item -Path $sourcePath -Destination $destinationPath -Force
}

$manifestPath = Join-Path $RootDir "manifest.json"
if (-not (Test-Path $manifestPath)) {
  throw "manifest.json was not found in $RootDir"
}

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if (-not $version -or $version -notmatch '^\d+\.\d+$') {
  throw "manifest.json version must use the x.x format. Current value: '$version'"
}

$packageItems = @(
  "manifest.json",
  "background.js",
  "content-script.js",
  "shared.js",
  "offscreen.html",
  "offscreen.js",
  "lib",
  "popup"
)

$packageBaseName = "it-step-materials-downloader-$version"
$versionedPackagePath = Join-Path $OutputDir "$packageBaseName.zip"
$stablePackagePath = Join-Path $OutputDir $StableFileName
$packageInfoPath = Join-Path $OutputDir "package-info.json"
$stageDir = Join-Path $RootDir ".cws-package-stage"

if (Test-Path $stageDir) {
  Remove-Item -Path $stageDir -Recurse -Force
}

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

New-Item -ItemType Directory -Path $stageDir | Out-Null

try {
  foreach ($item in $packageItems) {
    Copy-PackageItem -SourceRoot $RootDir -StageRoot $stageDir -RelativePath $item
  }

  Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $versionedPackagePath -CompressionLevel Optimal -Force
  Copy-Item -Path $versionedPackagePath -Destination $stablePackagePath -Force

  $packageInfo = [ordered]@{
    version = $version
    generatedAt = (Get-Date).ToString("o")
    versionedPackage = $versionedPackagePath
    stablePackage = $stablePackagePath
    includedPaths = $packageItems
  }

  $packageInfo | ConvertTo-Json -Depth 4 | Set-Content -Path $packageInfoPath -Encoding UTF8
  $packageInfo | ConvertTo-Json -Depth 4
}
finally {
  if (Test-Path $stageDir) {
    Remove-Item -Path $stageDir -Recurse -Force
  }
}
