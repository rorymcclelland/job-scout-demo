# Lets the "Open folder" link on each board card open the pack's folder in
# File Explorer (backlog F6).
#
# Run once, in PowerShell, from the Job Scout folder:
#     powershell -ExecutionPolicy Bypass -File scripts\install-folder-links.ps1
#
# Browsers will not open a folder on your computer from a web page, so the board
# uses links that start "jobscout:". This registers that kind of link for your
# Windows account only (no administrator rights), pointing it at
# scripts\open-folder.ps1, which opens only existing folders inside
# Professional development. The first time you click one, Firefox asks which
# application to use: choose the suggested Windows handler and tick "Always".
#
# To remove it:
#     Remove-Item -Recurse "HKCU:\Software\Classes\jobscout"

$Script = Join-Path $PSScriptRoot "open-folder.ps1"
if (-not (Test-Path -LiteralPath $Script)) { throw "open-folder.ps1 is missing from $PSScriptRoot" }

$Key = "HKCU:\Software\Classes\jobscout"
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name "(default)" -Value "URL:Job Scout folder link"
Set-ItemProperty -Path $Key -Name "URL Protocol" -Value ""
New-Item -Path "$Key\shell\open\command" -Force | Out-Null
$Command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`" `"%1`""
Set-ItemProperty -Path "$Key\shell\open\command" -Name "(default)" -Value $Command

Write-Host "Done: 'Open folder' links on the board now open File Explorer."
Write-Host "Try one from PowerShell:  Start-Process 'jobscout:open?folder=Glint%20-%20VP%20of%20Product'"
