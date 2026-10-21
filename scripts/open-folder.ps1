# Opens a pack folder in File Explorer when you click "Open folder" on a board
# card (backlog F6). Windows runs this for jobscout: links once
# install-folder-links.ps1 has been run.
#
# It only ever opens an existing folder inside Professional development. Any
# other address, a path that climbs out with "..", or a file instead of a folder
# is refused, so a link cannot be used to run or open anything else.

param([string]$Uri = "")

# The Professional development folder sits beside the Job Scout folder.
$Root = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "Professional development"

Add-Type -AssemblyName PresentationFramework

function Refuse($why) {
  [System.Windows.MessageBox]::Show("Job Scout could not open that folder.`n`n$why", "Job Scout") | Out-Null
  exit 1
}

if ($Uri -notmatch '^jobscout:open\?folder=(.+)$') { Refuse "The link was not a Job Scout folder link." }
$rel = [uri]::UnescapeDataString($Matches[1]).Trim().TrimStart('\', '/')
if ($rel -eq "" -or $rel -match '\.\.' -or $rel -match '^[a-zA-Z]:' -or $rel -match '[<>|"*?]') {
  Refuse "The folder name was not allowed: $rel"
}

$full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
if (-not $full.StartsWith($Root + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
  Refuse "That folder is outside Professional development."
}
if (-not (Test-Path -LiteralPath $full -PathType Container)) {
  Refuse "There is no folder called:`n$full"
}

Start-Process -FilePath "explorer.exe" -ArgumentList "`"$full`""
