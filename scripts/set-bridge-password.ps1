# Moves the Proton Mail Bridge credentials out of the Job Scout folder (backlog H1).
#
# Claude's scheduled tasks can read the Job Scout and Professional development
# folders, and they also read text written by strangers (adverts, alert emails).
# So the Bridge password must not live in either folder. This script stores it in
#   %LOCALAPPDATA%\JobScout\bridge.env             the user name and other settings
#   %LOCALAPPDATA%\JobScout\bridge-password.dpapi  the password, encrypted with
#                                                  Windows DPAPI for your account
# DPAPI means only your Windows account, on this PC, can decrypt it. The script
# never prints the password, and it offers to delete .env when it has finished.
#
# Run it once, in PowerShell, from the Job Scout folder:
#   powershell -ExecutionPolicy Bypass -File scripts\set-bridge-password.ps1
# Run it again whenever Bridge gives you a new password.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$secure = Join-Path $env:LOCALAPPDATA 'JobScout'
$dotenv = Join-Path $root '.env'

# Settings already in .env (other than the password) are carried across.
$carried = [ordered]@{}
if (Test-Path -LiteralPath $dotenv) {
  foreach ($line in Get-Content -LiteralPath $dotenv) {
    if ($line -match '^\s*(BRIDGE_[A-Z_]+)\s*=\s*(.*)$' -and $Matches[1] -ne 'BRIDGE_PASSWORD' -and $Matches[2].Trim()) {
      $carried[$Matches[1]] = $Matches[2].Trim().Trim('"', "'")
    }
  }
}

Write-Host ''
Write-Host 'Job Scout: store the Proton Mail Bridge credentials out of reach'
Write-Host 'Open Bridge, click your account, and copy the IMAP user name and password it shows.'
Write-Host '(That is the password Bridge generates for mail apps, not your Proton password.)'
Write-Host ''

$defaultUser = $carried['BRIDGE_USER']
$prompt = if ($defaultUser) { "Bridge user name [$defaultUser]" } else { 'Bridge user name' }
$user = Read-Host $prompt
if (-not $user) { $user = $defaultUser }
if (-not $user) { Write-Host 'No user name given. Nothing changed.'; exit 1 }
$carried['BRIDGE_USER'] = $user

$pw = Read-Host 'Bridge password (hidden)' -AsSecureString
if ($pw.Length -eq 0) { Write-Host 'No password given. Nothing changed.'; exit 1 }

New-Item -ItemType Directory -Force -Path $secure | Out-Null
# Only your account may open the folder.
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $secure /inheritance:r /grant:r "${me}:(OI)(CI)F" | Out-Null

$lines = @('# Written by scripts\set-bridge-password.ps1. The password is not here: it is in bridge-password.dpapi.')
foreach ($k in $carried.Keys) { $lines += "$k=$($carried[$k])" }
Set-Content -LiteralPath (Join-Path $secure 'bridge.env') -Value $lines -Encoding UTF8
ConvertFrom-SecureString -SecureString $pw | Set-Content -LiteralPath (Join-Path $secure 'bridge-password.dpapi') -Encoding ASCII
Write-Host "Stored in $secure (readable only by $me)."

# Check that the stored password can be read back, then test Bridge.
Push-Location $root
try {
  Write-Host ''
  Write-Host 'Testing the connection to Bridge...'
  npm run --silent check-bridge
  $ok = ($LASTEXITCODE -eq 0)
} finally { Pop-Location }

if (Test-Path -LiteralPath $dotenv) {
  Write-Host ''
  if ($ok) {
    $answer = Read-Host 'Bridge works with the stored password. Delete .env from the Job Scout folder now? (y/n)'
  } else {
    Write-Host 'The Bridge test did not pass, so .env has been kept for now. Fix Bridge, then run this script again.'
    $answer = 'n'
  }
  if ($answer -match '^[yY]') {
    Remove-Item -LiteralPath $dotenv
    Write-Host '.env deleted. The password now lives only in the encrypted store.'
  } elseif ($ok) {
    Write-Host '.env kept. Delete its BRIDGE_PASSWORD line yourself: until then each run.md will warn about it.'
  }
}
