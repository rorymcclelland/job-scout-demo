# Sets up the Job Scout's Windows tasks (backlog B8; reader added in Sprint 5c, H5).
#
# Run once, in PowerShell (not as administrator), from the Job Scout folder:
#     powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
#
# It registers three Windows scheduled tasks, all running as you, only while you
# are signed in, with no administrator rights:
#
#   "Job Scout wake"    06:25  scripts\keep-awake.ps1  wakes the PC, on mains power only, and
#                                                     keeps it awake until about 08:55 so
#                                                     Claude's 07:23 and 08:10 parts can reach
#                                                     it (G7, Sprint 5d). Never on battery.
#   "Job Scout"         06:30  npm run scout          reads the alerts (log: data\scout.log)
#   "Job Scout reader"  07:45  npm run read-adverts   reads the adverts with the local model
#                                                     (log: data\reader.log; waits up to 30
#                                                     minutes for the morning run's list)
#
# The two npm tasks also "Start when available", so a morning missed while the
# computer was asleep (on battery, say) runs as soon as it wakes. Claude's two parts
# cannot catch up that way: they say so in a message instead.
#
# It also makes sure Ollama uses the RTX 5080, not the AMD 890M, by setting
# HIP_VISIBLE_DEVICES and ROCR_VISIBLE_DEVICES to -1 for your account (H13).
# Restart Ollama once afterwards (Quit from its tray icon, then start it again).
#
# To change a time, edit $ScoutAt or $ReaderAt and run this again. To remove them:
#     Unregister-ScheduledTask -TaskName "Job Scout" -Confirm:$false
#     Unregister-ScheduledTask -TaskName "Job Scout reader" -Confirm:$false
#     Unregister-ScheduledTask -TaskName "Job Scout wake" -Confirm:$false

$WakeAt   = "06:25"
$AwakeMinutes = 150
$ScoutAt  = "06:30"
$ReaderAt = "07:45"
$Folder = Split-Path -Parent $PSScriptRoot
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Join-Path $Folder "data") | Out-Null

function Register-JobScoutTask($Name, $Script, $Log, $At, $Minutes, $Description) {
  $Command  = "cd /d `"$Folder`" && `"$Npm`" run $Script >> data\$Log 2>&1"
  $Action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $Command" -WorkingDirectory $Folder
  $Trigger  = New-ScheduledTaskTrigger -Daily -At $At
  $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes $Minutes)
  Register-ScheduledTask -TaskName $Name -Description $Description -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
  Write-Host "Scheduled: '$Name' runs npm run $Script daily at $At, catching up on wake. Log: data\$Log"
}

Register-JobScoutTask "Job Scout" "scout" "scout.log" $ScoutAt 15 "Reads job alerts through Proton Mail Bridge and filters them. See README.md."
Register-JobScoutTask "Job Scout reader" "read-adverts" "reader.log" $ReaderAt 60 "Reads the day's adverts on this PC with the local model (Ollama). See README.md."

# G7: wake on mains power only. New-ScheduledTaskSettingsSet's defaults already refuse
# to start on battery and stop if the PC goes on battery; -WakeToRun adds the wake.
$WakeAction   = New-ScheduledTaskAction -Execute "powershell.exe" `
                  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\keep-awake.ps1`" -Minutes $AwakeMinutes" `
                  -WorkingDirectory $Folder
$WakeTrigger  = New-ScheduledTaskTrigger -Daily -At $WakeAt
$WakeSettings = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes ($AwakeMinutes + 10))
Register-ScheduledTask -TaskName "Job Scout wake" -Description "Wakes the PC on mains power and keeps it awake for the Job Scout morning. See README.md." `
  -Action $WakeAction -Trigger $WakeTrigger -Settings $WakeSettings -Force | Out-Null
Write-Host "Scheduled: 'Job Scout wake' wakes the PC at $WakeAt on mains power only and keeps it awake for $AwakeMinutes minutes."

# Wake timers must be allowed in the power plan for the wake to work. This only reads the setting.
$WakeTimers = (powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE) 2>$null | Select-String "Current AC Power Setting Index"
if ($WakeTimers -and $WakeTimers.ToString() -match "0x00000000") {
  Write-Host "Wake timers are switched off on mains power, so the PC will not wake by itself. To allow them: Control Panel, Power Options, Change plan settings, Change advanced power settings, Sleep, Allow wake timers, Plugged in: Enable."
} elseif (-not $WakeTimers) {
  Write-Host "Could not read the wake-timer setting. Check: Power Options, Sleep, Allow wake timers, Plugged in: Enable."
}
if ((powercfg /a) -match "Standby \(S0 Low Power Idle\)") {
  Write-Host "This PC uses Modern Standby. Wake timers usually still work on mains power; check data\scout.log the first morning."
}

foreach ($Name in "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES") {
  if ([Environment]::GetEnvironmentVariable($Name, "User") -ne "-1") {
    [Environment]::SetEnvironmentVariable($Name, "-1", "User")
    Write-Host "Set $Name=-1 for your account, so Ollama uses the RTX 5080. Restart Ollama once (Quit from the tray icon, then start it)."
  }
}
Write-Host "Try them now with:  Start-ScheduledTask -TaskName 'Job Scout'   and   Start-ScheduledTask -TaskName 'Job Scout reader'"
