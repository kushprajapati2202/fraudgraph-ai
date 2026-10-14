<#
.SYNOPSIS
  FraudGraph AI developer commands for Windows.

.DESCRIPTION
  By default every command runs inside WSL (Ubuntu), so nothing has to be installed on Windows itself.
  Use -Native on machines where Python 3.12 and Node 20+ are installed on Windows.

.EXAMPLE
  .\scripts\windows\fg.ps1 setup          # one-time: uv, Python venv, Node, npm install, dataset (in WSL)
  .\scripts\windows\fg.ps1 dev            # API :8000 + Vite :5173 -> open http://127.0.0.1:5173
  .\scripts\windows\fg.ps1 check          # pytest + typecheck + build
  .\scripts\windows\fg.ps1 check -Eval    # ...and regenerate docs/evaluation.md
  .\scripts\windows\fg.ps1 serve          # built UI + API on http://127.0.0.1:8000
  .\scripts\windows\fg.ps1 smoke -BaseUrl http://127.0.0.1:8000
  .\scripts\windows\fg.ps1 dev -Native    # same, using Windows Python/Node
#>
param(
    [Parameter(Position = 0)][ValidateSet("setup", "dev", "api", "web", "check", "serve", "smoke")][string]$Command = "dev",
    [switch]$Native,
    [switch]$Eval,
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [string]$DemoToken = ""
)
$ErrorActionPreference = "Stop"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if ($Command -eq "smoke") {
    & (Join-Path $Repo "scripts\smoke.ps1") -BaseUrl $BaseUrl -DemoToken $DemoToken
    exit $LASTEXITCODE
}

# ---------------- WSL mode (default) ----------------
if (-not $Native) {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { throw "WSL is not available. Install WSL or use -Native." }
    $map = @{ setup = "setup.sh"; dev = "dev.sh"; api = "dev.sh api"; web = "dev.sh web"; check = "check.sh"; serve = "serve.sh" }
    $script = $map[$Command]
    if ($Command -eq "check" -and $Eval) { $script += " --eval" }
    Write-Host "==> [WSL] bash scripts/wsl/$script" -ForegroundColor Cyan
    wsl --cd "$Repo" -- bash -c "bash scripts/wsl/$script"
    exit $LASTEXITCODE
}

# ---------------- Native Windows mode ----------------
Set-Location $Repo
$venvPy = Join-Path $Repo ".venv\Scripts\python.exe"

function Find-Python {
    # Returns @{ Exe = ...; Args = @(...) }. Skips the Microsoft Store alias stubs in WindowsApps.
    $candidates = @(@{ Exe = "py"; Args = @("-3.12") }, @{ Exe = "python"; Args = @() })
    foreach ($c in $candidates) {
        $cmd = Get-Command $c.Exe -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -notlike "*WindowsApps*") { return $c }
    }
    throw "Python 3.12 not found on Windows. Install it, or run without -Native to use WSL."
}

function Assert-Node {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Node/npm not found on Windows. Install Node 20+, or run without -Native." }
}

function Install-FrontendDeps {
    Assert-Node
    Push-Location (Join-Path $Repo "frontend")
    try {
        # node_modules holds platform-specific binaries (esbuild); reinstall if it was created in WSL.
        $marker = "node_modules\.fraudgraph-platform"
        if ((Test-Path node_modules) -and (-not (Test-Path $marker) -or (Get-Content $marker) -ne "windows")) {
            Remove-Item -Recurse -Force node_modules
        }
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Set-Content -Path $marker -Value "windows" -Encoding ascii
    } finally { Pop-Location }
}

switch ($Command) {
    "setup" {
        $py = Find-Python
        if (-not (Test-Path $venvPy)) {
            $pyArgs = $py.Args + @("-m", "venv", ".venv")
            & $py.Exe @pyArgs
            if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
        }
        & $venvPy -m pip install --upgrade pip
        & $venvPy -m pip install -r requirements-dev.txt
        if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
        Install-FrontendDeps
        & $venvPy scripts\generate_dataset.py
        if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env (add GEMINI_API_KEY to enable Gemini)" }
    }
    "api" { & $venvPy -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend }
    "web" { Assert-Node; Push-Location frontend; try { npm run dev } finally { Pop-Location } }
    "dev" {
        $api = Start-Process -FilePath $venvPy -ArgumentList "-m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload --reload-dir backend" -PassThru -NoNewWindow
        try { Assert-Node; Push-Location frontend; npm run dev } finally { Pop-Location; Stop-Process -Id $api.Id -ErrorAction SilentlyContinue }
    }
    "check" {
        & $venvPy -m pytest backend/tests -q -p no:cacheprovider; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Push-Location frontend
        try {
            npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally { Pop-Location }
        if ($Eval) { & $venvPy scripts\evaluate.py --latency | Out-Null; Write-Host "Wrote docs/evaluation.md" }
        Write-Host "All checks passed" -ForegroundColor Green
    }
    "serve" {
        Push-Location frontend; try { npm run build } finally { Pop-Location }
        & $venvPy -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
    }
}
