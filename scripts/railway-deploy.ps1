# Deploy AI Workers to Railway (persistent SQLite + Docker).
# Usage:
#   .\scripts\railway-deploy.ps1                    # guided setup + deploy if logged in
#   .\scripts\railway-deploy.ps1 -BaseUrl "https://your-app.up.railway.app"  # verify only
#
# Prerequisites: Node 22+, GitHub repo pushed to origin/main, Railway account.
# Install CLI once: npm i -g @railway/cli   (or use npx @railway/cli)

param(
    [string]$BaseUrl = "",
    [switch]$SkipDeploy
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Write-Step([string]$n, [string]$msg) {
    Write-Host "`n[$n] $msg" -ForegroundColor Cyan
}

function Invoke-Railway {
    param([string[]]$Args)
    $cli = (Get-Command railway -ErrorAction SilentlyContinue).Source
    if ($cli) {
        & railway @Args
        return $LASTEXITCODE
    }
    & npx --yes @railway/cli @Args
    return $LASTEXITCODE
}

Write-Host "=== AI Workers — Railway deploy ===" -ForegroundColor Cyan

# --- Step 1: Link GitHub repo ------------------------------------------------
Write-Step "1/6" "Link GitHub repository to Railway"
Write-Host @"
In Railway Dashboard (https://railway.app/new):
  1. New Project → Deploy from GitHub repo
  2. Select: razel369/ai-workers (or your fork)
  3. Railway auto-detects Dockerfile + railway.toml from repo root
  4. Wait for first build (may fail until env + volume are set — that's OK)
"@

# --- Step 2: Persistent volume -----------------------------------------------
Write-Step "2/6" "Add persistent volume at /app/data"
Write-Host @"
Railway Dashboard → your service → Volumes → Add Volume:
  Mount path: /app/data
  Size: 1 GB (or more as you grow)

This stores earnings.db and per-tenant worker databases across restarts.
Without it, GET /health returns persistentStorage: false.
"@

# --- Step 3: Environment variables -------------------------------------------
Write-Step "3/6" "Paste environment variables"
$envExample = Join-Path $Root ".env.production.example"
if (Test-Path $envExample) {
    Write-Host "Copy from: $envExample" -ForegroundColor Yellow
    Write-Host ""
    Get-Content $envExample | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '\S' } | ForEach-Object {
        Write-Host "  $_" -ForegroundColor DarkGray
    }
} else {
    Write-Host "Missing .env.production.example — see railway.toml [variables] section." -ForegroundColor Yellow
}

Write-Host @"

Railway Dashboard → service → Variables → Raw Editor:
  Paste all non-comment lines from .env.production.example
  Replace placeholder values (PUBLIC_BASE_URL, LLM_API_KEY, ADMIN_TOKEN, payment channels)

Generate ADMIN_TOKEN:
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

Required for production health:
  PUBLIC_BASE_URL   = https://<your-service>.up.railway.app  (no trailing slash)
  ADMIN_TOKEN       = <random hex>
  LLM_API_KEY       = sk-...
  DB_PATH           = /app/data/earnings.db
  TENANTS_DIR       = /app/data/tenants
  TRUST_PROXY_HEADERS = 1
  At least one of: BIT_PHONE or PAYPAL_ME
"@

# --- Step 4: CLI link (optional) ---------------------------------------------
Write-Step "4/6" "Link local folder to Railway project (CLI)"
$loggedIn = $false
$railwayToken = $env:RAILWAY_TOKEN
if ($railwayToken) {
    Write-Host "RAILWAY_TOKEN detected — using non-interactive CLI auth." -ForegroundColor Green
    $env:RAILWAY_TOKEN = $railwayToken
}

try {
    Invoke-Railway @("whoami") | Out-Host
    if ($LASTEXITCODE -eq 0) { $loggedIn = $true }
} catch {
    Write-Host "Railway CLI not logged in." -ForegroundColor Yellow
}

if (-not $loggedIn) {
    Write-Host @"
Not logged in. Options:
  A) Dashboard-only (recommended): push to main — GitHub-connected Railway auto-deploys.
  B) Non-interactive CI: set RAILWAY_TOKEN from Railway Dashboard -> Account -> Tokens.
  C) Interactive: npx @railway/cli login  (browser — run locally, not in CI)

Then re-run this script, or finish in the Railway dashboard.
"@ -ForegroundColor Yellow
} else {
    Write-Host "Logged in to Railway." -ForegroundColor Green
    if (-not $SkipDeploy) {
        if (-not (Test-Path (Join-Path $Root ".railway"))) {
            Write-Host "Linking project (select your AI Workers service)..." -ForegroundColor Yellow
            Invoke-Railway @("link") | Out-Host
        } else {
            Write-Host "Project already linked (.railway present)." -ForegroundColor Green
        }
    }
}

# --- Step 5: Deploy ------------------------------------------------------------
Write-Step "5/6" "Deploy"
if ($loggedIn -and -not $SkipDeploy) {
    Write-Host "Deploying to Railway..." -ForegroundColor Yellow
    Invoke-Railway @("up", "--detach") | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Deploy command failed — finish setup in dashboard and push to main." -ForegroundColor Red
    } else {
        Write-Host "Deploy triggered." -ForegroundColor Green
    }
} else {
    Write-Host "Deploy via: git push origin main (if GitHub connected) or Railway dashboard → Deploy." -ForegroundColor Yellow
}

# --- Step 6: Verify health ---------------------------------------------------
Write-Step "6/6" "Verify health (persistentStorage: true)"
if (-not $BaseUrl) {
    if ($loggedIn) {
        try {
            $statusJson = Invoke-Railway @("status", "--json") 2>$null
            if ($statusJson) {
                $status = $statusJson | ConvertFrom-Json
                if ($status.url) { $BaseUrl = $status.url }
            }
        } catch { }
    }
    if (-not $BaseUrl) {
        $BaseUrl = Read-Host "Enter production URL (e.g. https://your-app.up.railway.app)"
    }
}

$BaseUrl = $BaseUrl.TrimEnd("/")
Write-Host "Checking $BaseUrl/health ..." -ForegroundColor Yellow

try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 30
    $ok = $health.ok -eq $true
    $persistent = $health.persistentStorage -eq $true
    Write-Host "  ok:                $($health.ok)" -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
    Write-Host "  persistentStorage: $($health.persistentStorage)" -ForegroundColor $(if ($persistent) { "Green" } else { "Red" })
    Write-Host "  adminEnabled:      $($health.adminEnabled)"
    Write-Host "  llmConfigured:     $($health.llmConfigured)"
    Write-Host "  dbPath:            $($health.dbPath)"

    if (-not $persistent) {
        Write-Host "`nWARN: persistentStorage is false — add volume at /app/data and set DB_PATH/TENANTS_DIR." -ForegroundColor Red
        exit 1
    }
    if (-not $ok) {
        Write-Host "`nHealth check failed." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Could not reach /health: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Wait for deploy to finish, then run:" -ForegroundColor Yellow
    Write-Host "  .\scripts\smoke-production.ps1 -BaseUrl `"$BaseUrl`"" -ForegroundColor Yellow
    exit 1
}

Write-Host "`nRunning smoke tests..." -ForegroundColor Yellow
$smoke = Join-Path $Root "scripts\smoke-production.ps1"
if (Test-Path $smoke) {
    & $smoke -BaseUrl $BaseUrl
    exit $LASTEXITCODE
}

Write-Host "Health OK. Run .\scripts\smoke-production.ps1 -BaseUrl `"$BaseUrl`" for full checks." -ForegroundColor Green
exit 0
