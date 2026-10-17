<#
.SYNOPSIS
  End-to-end smoke test against a running FraudGraph AI instance (local or Cloud Run).
.EXAMPLE
  .\scripts\windows\smoke.ps1 -BaseUrl https://fraudgraph-ai-xxxx.a.run.app -DemoToken $env:DEMO_TOKEN
#>
param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [string]$DemoToken = ""
)
$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$headers = @{}
if ($DemoToken) { $headers["X-Demo-Token"] = $DemoToken }
$failures = 0

function Step([string]$name, [scriptblock]$action) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result = & $action
        Write-Host ("PASS  {0,-38} {1,6} ms" -f $name, $sw.ElapsedMilliseconds) -ForegroundColor Green
        return $result
    } catch {
        Write-Host ("FAIL  {0,-38} {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
        $script:failures++
        return $null
    }
}

function Api([string]$method, [string]$path, $body = $null) {
    $params = @{ Method = $method; Uri = "$BaseUrl$path"; Headers = $headers; ContentType = "application/json" }
    if ($null -ne $body) { $params["Body"] = ($body | ConvertTo-Json -Depth 6) }
    return Invoke-RestMethod @params
}

$health = Step "GET /api/health" { $h = Api GET "/api/health"; if ($h.status -ne "ok") { throw "status=$($h.status)" }; $h }
Step "health exposes no key material" { $raw = (Invoke-WebRequest -UseBasicParsing "$BaseUrl/api/health").Content; if ($raw -match "AIza") { throw "possible API key in response" } } | Out-Null
Step "POST /api/demo/reset" { Api POST "/api/demo/reset" } | Out-Null
$run = Step "POST /api/analysis/run" { Api POST "/api/analysis/run" @{ scenario_id = "layered-transfer-01"; time_window_minutes = 60 } }
$caseId = $null
if ($run -and $run.focus_case_ids.Count -gt 0) { $caseId = $run.focus_case_ids[0] }
Step "layered scenario produced a case" { if (-not $caseId) { throw "no focus case" } } | Out-Null
if ($caseId) {
    $detail = Step "GET /api/cases/$caseId" { Api GET "/api/cases/$caseId" }
    Step "GET /api/graph?case_id" { $g = Api GET "/api/graph?case_id=$caseId"; if ($g.edges.Count -lt 1) { throw "no edges" }; $g } | Out-Null
    $inv = Step "POST investigate (Gemini or fallback)" { Api POST "/api/cases/$caseId/investigate" @{} }
    if ($inv) {
        Write-Host ("      Gemini status: {0} {1}" -f $inv.response.status, $inv.response.reason)
        if ($inv.response.status -eq "OK" -and $detail) {
            $allowed = @($detail.evidence | ForEach-Object { $_.evidence_id })
            Step "all citations resolve to case evidence" {
                foreach ($f in @($inv.response.result.observed_facts) + @($inv.response.result.risk_indicators)) {
                    foreach ($id in $f.evidence_ids) { if ($allowed -notcontains $id) { throw "invalid citation $id" } }
                }
            } | Out-Null
        }
    }
    Step "POST decision" { Api POST "/api/cases/$caseId/decision" @{ decision = "REQUEST_MORE_EVIDENCE"; rationale = "Smoke test: verify source records." } } | Out-Null
    Step "decision visible in audit history" {
        $d = Api GET "/api/cases/$caseId"
        if (-not ($d.audit_events | Where-Object { $_.event_type -eq "ANALYST_DECISION" })) { throw "no decision event" }
    } | Out-Null
}
Step "GET / serves the UI" { $r = Invoke-WebRequest -UseBasicParsing "$BaseUrl/"; if ($r.Content -notmatch "<div id=`"root`">") { throw "index.html not served" } } | Out-Null
Step "POST /api/demo/reset (restore baseline)" { Api POST "/api/demo/reset" } | Out-Null
Step "POST /api/analysis/run (restore cases)" { Api POST "/api/analysis/run" @{} } | Out-Null

if ($failures -gt 0) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host "All smoke checks passed" -ForegroundColor Green
