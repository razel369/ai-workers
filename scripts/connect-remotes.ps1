# Connect AI Workers to GitHub + Vercel (run once after cloning).
# Requires: GitHub CLI (gh), Vercel CLI (vercel), Node 22+

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "=== AI Workers — GitHub + Vercel setup ===" -ForegroundColor Cyan

# GitHub
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = "${env:ProgramFiles}\GitHub CLI\gh.exe" }

if (-not (Test-Path $gh)) {
  Write-Host "Install GitHub CLI: winget install GitHub.cli" -ForegroundColor Yellow
  exit 1
}

& $gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Logging into GitHub (browser)..." -ForegroundColor Yellow
  & $gh auth login -h github.com -p https -w
}

$remote = git remote get-url origin 2>$null
if (-not $remote) {
  $repoName = Read-Host "GitHub repo name (e.g. ai-workers)"
  if (-not $repoName) { $repoName = "ai-workers" }
  Write-Host "Creating public repo razel369/$repoName ..." -ForegroundColor Yellow
  & $gh repo create "razel369/$repoName" --public --source=. --remote=origin --push
} else {
  Write-Host "Remote already set: $remote" -ForegroundColor Green
  git push -u origin main
}

# Vercel
vercel whoami 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Logging into Vercel (browser)..." -ForegroundColor Yellow
  vercel login
}

Write-Host "Linking Vercel project..." -ForegroundColor Yellow
vercel link --yes
Write-Host "Set production env vars in Vercel dashboard:" -ForegroundColor Cyan
Write-Host "  ADMIN_TOKEN, LLM_API_KEY, PUBLIC_BASE_URL, BIT_PHONE, PAYPAL_ME"
Write-Host ""
Write-Host "NOTE: Vercel serverless has ephemeral disk — SQLite resets on cold deploy." -ForegroundColor Yellow
Write-Host "For production with persistent data, use Railway/Fly (Dockerfile) from the same repo." -ForegroundColor Yellow
Write-Host ""
Write-Host "Deploy preview: vercel" -ForegroundColor Green
Write-Host "Deploy production: vercel --prod" -ForegroundColor Green
