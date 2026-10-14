<#
.SYNOPSIS
  Capture headless screenshots of the running app with Microsoft Edge (for visual checks and the proposal PDF).
.EXAMPLE
  .\scripts\windows\screenshot.ps1 -BaseUrl http://127.0.0.1:8000 -OutDir docs\screenshots
#>
param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [string]$OutDir = "docs\screenshots",
    [ValidateSet("", "light", "dark")][string]$Theme = "",
    [string]$CaseId = "",
    [string[]]$Only = @()
)
$ErrorActionPreference = "Stop"
$edge = @("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
          "C:\Program Files\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Edge or Chrome not found." }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$profileDir = Join-Path $env:TEMP "fraudgraph-shots-profile"
$Only = @($Only | ForEach-Object { $_ -split "," } | Where-Object { $_ })
$caseId = if ($CaseId) { $CaseId } else { (Invoke-RestMethod "$BaseUrl/api/cases").items[0].case_id }

$pages = [ordered]@{
    "overview"     = @("/", 1500)
    "cases"        = @("/cases", 900)
    "case"         = @("/cases/$caseId", 2700)
    "transactions" = @("/transactions", 1300)
    "network"      = @("/network", 1000)
    "simulator"    = @("/simulator", 900)
    "settings"     = @("/settings", 1700)
}
foreach ($name in $pages.Keys) {
    if ($Only.Count -and $Only -notcontains $name) { continue }
    $file = Join-Path $OutDir $(if ($Theme) { "$name-$Theme.png" } else { "$name.png" })
    Remove-Item $file -ErrorAction SilentlyContinue
    $edgeArgs = @("--headless", "--enable-automation", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
              "--user-data-dir=$profileDir", "--window-size=1440,$($pages[$name][1])", "--virtual-time-budget=12000", "--screenshot=$file")
    $edgeArgs += "$BaseUrl$($pages[$name][0])$(if ($Theme) { "?theme=$Theme" })"
    $p = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(120000)) {
        Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*fraudgraph-shots-profile*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Write-Host ("{0,-14} {1}" -f $name, $(if (Test-Path $file) { $file } else { "FAILED" }))
}
