// G7 (Sprint 5d): the Windows schedule wakes the PC on mains power only and keeps it awake.
// The PowerShell cannot run here, so these check the script's text for the settings that matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "scripts");
const install = fs.readFileSync(path.join(dir, "install-schedule.ps1"), "utf8");
const awake = fs.readFileSync(path.join(dir, "keep-awake.ps1"), "utf8");

test("G7: a wake task at 06:25 that wakes the PC", () => {
  assert.match(install, /\$WakeAt\s*=\s*"06:25"/);
  assert.match(install, /TaskName "Job Scout wake"/);
  assert.match(install, /\$WakeSettings = New-ScheduledTaskSettingsSet -WakeToRun/);
});

test("G7: the wake task never runs on battery (Windows' defaults are kept)", () => {
  const line = install.split("\n").find((l) => l.startsWith("$WakeSettings"))!;
  assert.doesNotMatch(line, /AllowStartIfOnBatteries|DontStopIfGoingOnBatteries/);
});

test("G7: the mail read and the reader still run on battery and catch up on wake", () => {
  assert.match(install, /-StartWhenAvailable -AllowStartIfOnBatteries/);
});

test("G7: keep-awake holds the PC awake, then lets it sleep, and changes no power settings", () => {
  assert.match(awake, /SetThreadExecutionState\(\$Continuous \+ \$SystemRequired\)/);
  assert.match(awake, /finally \{\s*\[JobScout\.Power\]::SetThreadExecutionState\(\$Continuous\)/);
  assert.doesNotMatch(awake + install, /powercfg \/(change|setacvalueindex|setdcvalueindex|setactive)/i);
  assert.match(install, /\$AwakeMinutes = 150/);
});
