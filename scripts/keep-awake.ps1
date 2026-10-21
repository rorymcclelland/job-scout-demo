# Keeps this PC awake for the Job Scout morning (backlog G7, Sprint 5d).
#
# Windows puts a computer woken by a timer back to sleep after about two minutes
# without a keyboard or mouse. That would let the 06:30 mail read run, then sleep
# through Claude's 07:23 and 08:10 parts. Run by the "Job Scout wake" task at 06:25,
# only on mains power, this asks Windows to stay awake (the screen may stay off)
# for $Minutes, then lets it sleep normally again. It changes no power settings.

param([int]$Minutes = 150)

Add-Type -Namespace JobScout -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$Continuous     = [uint32]2147483648   # ES_CONTINUOUS
$SystemRequired = [uint32]1            # ES_SYSTEM_REQUIRED
[JobScout.Power]::SetThreadExecutionState($Continuous + $SystemRequired) | Out-Null
try {
  Start-Sleep -Seconds ($Minutes * 60)
} finally {
  [JobScout.Power]::SetThreadExecutionState($Continuous) | Out-Null
}
