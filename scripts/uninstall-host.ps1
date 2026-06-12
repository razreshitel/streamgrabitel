# Removes the StreamGrab native messaging host registration.
# Run: npm run uninstall-host

$ErrorActionPreference = 'SilentlyContinue'
$HostName = 'com.streamgrab.host'

$targets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
foreach ($reg in $targets) {
  if (Test-Path $reg) {
    Remove-Item -Path $reg -Force
    Write-Host "Removed: $reg"
  }
}

$ManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) "$HostName.json"
if (Test-Path $ManifestPath) {
  Remove-Item -Path $ManifestPath -Force
  Write-Host "Removed: $ManifestPath"
}
Write-Host 'Native host unregistered.'
