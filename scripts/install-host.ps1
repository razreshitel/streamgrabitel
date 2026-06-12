# Registers the StreamGrab native messaging host with Chrome (and Edge).
# Run: npm run install-host   (or: powershell -ExecutionPolicy Bypass -File scripts/install-host.ps1)

$ErrorActionPreference = 'Stop'

# Pinned extension ID, derived from manifest.json "key" (see scripts/gen-key.mjs).
$ExtensionId = 'eogbccakibimjjinpjpbenjnmfgobegc'
$HostName = 'com.streamgrab.host'

$Root = Split-Path -Parent $PSScriptRoot
$HostBat = Join-Path $Root 'streamgrab-host.bat'
$ManifestPath = Join-Path $Root "$HostName.json"

if (-not (Test-Path $HostBat)) { throw "Launcher not found: $HostBat" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning 'Node.js was not found on PATH. The host needs Node to run.'
}

# Native messaging host manifest.
$manifest = [ordered]@{
  name           = $HostName
  description    = 'StreamGrab download helper (yt-dlp + ffmpeg)'
  path           = $HostBat
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$json = $manifest | ConvertTo-Json -Depth 5
# Write UTF-8 without BOM (Chrome rejects a BOM in the host manifest).
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote host manifest: $ManifestPath"

# Point each browser's registry at the manifest.
$targets = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName,
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName
)
foreach ($reg in $targets) {
  New-Item -Path $reg -Force | Out-Null
  Set-Item -Path $reg -Value $ManifestPath
  Write-Host "Registered: $reg"
}

Write-Host ''
Write-Host 'Done. Native host installed for extension id:' $ExtensionId
Write-Host 'If the extension was already loaded, reload it at chrome://extensions.'
