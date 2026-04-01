$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

node .\send-n8n-report.mjs
