param(
  [string]$TaskName = "N8N Workflow Health Email",
  [string]$At = "08:00"
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $projectDir "run-report.ps1"
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path $runnerPath)) {
  throw "Missing runner script at $runnerPath"
}

$triggerTime = [datetime]::ParseExact($At, "HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
$action = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Sends the n8n workflow health report email for the previous 24 hours." `
  -Force | Out-Null

Write-Host "Scheduled task '$TaskName' registered for $At every day."
