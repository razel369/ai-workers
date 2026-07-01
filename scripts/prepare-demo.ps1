# Prepare and run full worker tools demo (AI Workers).
# Usage:
#   .\scripts\prepare-demo.ps1            # checks + start server
#   .\scripts\prepare-demo.ps1 -CheckOnly # checks only, no start

param(
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Write-Ok([string]$msg) { Write-Host "OK    $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "WARN  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "FAIL  $msg" -ForegroundColor Red; exit 1 }

Write-Host "`n=== AI Workers - prepare full tools demo ===`n" -ForegroundColor Cyan

# --- Node version ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Fail "Node.js not found. Install Node 22.5+ from https://nodejs.org" }
$nodeVersion = node -p "process.versions.node"
$parts = $nodeVersion.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Write-Fail "Node $nodeVersion found - need >= 22.5 (package.json engines)"
}
Write-Ok "Node $nodeVersion"

# --- .env file ---
$envFile = Join-Path $Root ".env"
$demoExample = Join-Path $Root ".env.demo.example"
if (-not (Test-Path $envFile)) {
    if (Test-Path $demoExample) {
        Copy-Item $demoExample $envFile
        Write-Warn ".env missing - copied from .env.demo.example. Edit .env before real LLM demo."
    } else {
        Write-Fail ".env missing and .env.demo.example not found. Copy .env.example to .env"
    }
} else {
    Write-Ok ".env exists"
}

# --- Parse .env (simple key=value, ignore comments) ---
$envVars = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line -match '^([^=]+)=(.*)$') {
        $envVars[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

function Get-EnvVal([string]$key) {
    if ($envVars.ContainsKey($key) -and $envVars[$key]) { return $envVars[$key] }
    return [Environment]::GetEnvironmentVariable($key)
}

$adminToken = Get-EnvVal "ADMIN_TOKEN"
$llmKey = Get-EnvVal "LLM_API_KEY"
$webhookUrl = Get-EnvVal "WEBHOOK_NOTIFY_URL"
$meetingUrl = Get-EnvVal "MEETING_BOOKING_URL"
$googleKey = Get-EnvVal "GOOGLE_AI_API_KEY"
$trialDays = Get-EnvVal "TRIAL_DAYS"
$port = if (Get-EnvVal "PORT") { Get-EnvVal "PORT" } else { "8765" }
$baseUrl = if (Get-EnvVal "PUBLIC_BASE_URL") { Get-EnvVal "PUBLIC_BASE_URL" } else { "http://localhost:$port" }
$baseUrl = $baseUrl.TrimEnd("/")

if (-not $adminToken) {
    Write-Warn "ADMIN_TOKEN not set - admin panel and mark-worker-paid disabled"
} else {
    Write-Ok "ADMIN_TOKEN set ($($adminToken.Length) chars)"
}

if (-not $llmKey) {
    Write-Warn "LLM_API_KEY not set - mock agent mode (pattern tools, no real AI)"
} else {
    Write-Ok "LLM_API_KEY set - real agent loop enabled"
}

if (-not $webhookUrl) {
    Write-Warn "WEBHOOK_NOTIFY_URL not set - save_lead/escalate logged locally only"
} else {
    Write-Ok "WEBHOOK_NOTIFY_URL set"
}

if (-not $meetingUrl) {
    Write-Warn "MEETING_BOOKING_URL not set - book_meeting_link uses worker knowledge only"
} else {
    Write-Ok "MEETING_BOOKING_URL set"
}

if (-not $googleKey) {
    Write-Warn "GOOGLE_AI_API_KEY not set - generate_image runs in mock SVG mode"
} else {
    Write-Ok "GOOGLE_AI_API_KEY set - real image generation available"
}

if ($trialDays) {
    Write-Ok "TRIAL_DAYS=$trialDays"
} else {
    Write-Warn "TRIAL_DAYS not set (defaults to 0 - new workers need admin mark-paid)"
}

# --- node_modules ---
if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed" }
}
Write-Ok "dependencies ready"

if ($CheckOnly) {
    Write-Host "`nCheck-only mode - skipping server start.`n" -ForegroundColor Cyan
    exit 0
}

Write-Host "`n--- URLs (after server starts) ---" -ForegroundColor Cyan
Write-Host "  Home:        $baseUrl/"
Write-Host "  Marketplace: $baseUrl/marketplace"
Write-Host "  Magic flow:  $baseUrl/marketplace#/magic"
Write-Host "  Admin:       $baseUrl/marketplace#/admin"
Write-Host "  Health:      $baseUrl/health"
Write-Host ""
Write-Host "  ADMIN_TOKEN: store securely - needed for #/admin and mark-worker-paid API"
if ($adminToken) {
    Write-Host "  (current token length: $($adminToken.Length) chars - never paste in chat URLs)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  Full playbook: docs/FULL-TOOLS-DEMO.md"
Write-Host "`nStarting server (Ctrl+C to stop)...`n" -ForegroundColor Cyan

# Apply .env to this process (Node does not auto-load .env)
foreach ($key in $envVars.Keys) {
    Set-Item -Path "env:$key" -Value $envVars[$key]
}

npm start
