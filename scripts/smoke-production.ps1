# Smoke-test production endpoints (health, marketplace, templates API).
# Usage: .\scripts\smoke-production.ps1 -BaseUrl "https://your-app.up.railway.app"

param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$failed = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Path,
        [int]$ExpectedStatus = 200,
        [string]$ExpectBodyContains = ""
    )

    $url = "$BaseUrl$Path"
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
        $status = [int]$response.StatusCode
        if ($status -ne $ExpectedStatus) {
            Write-Host "FAIL  $Name — HTTP $status (expected $ExpectedStatus)" -ForegroundColor Red
            $script:failed++
            return
        }
        if ($ExpectBodyContains -and $response.Content -notmatch [regex]::Escape($ExpectBodyContains)) {
            Write-Host "FAIL  $Name — body missing '$ExpectBodyContains'" -ForegroundColor Red
            $script:failed++
            return
        }
        Write-Host "OK    $Name" -ForegroundColor Green
    }
    catch {
        Write-Host "FAIL  $Name — $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "`nSmoke test: $BaseUrl`n"

Test-Endpoint -Name "GET /health" -Path "/health" -ExpectBodyContains '"ok": true'
Test-Endpoint -Name "GET /marketplace" -Path "/marketplace" -ExpectBodyContains "marketplace"
Test-Endpoint -Name "GET /api/workers/templates" -Path "/api/workers/templates" -ExpectBodyContains '"templates"'
Test-Endpoint -Name "GET /privacy" -Path "/privacy" -ExpectBodyContains "פרטיות"
Test-Endpoint -Name "GET /terms" -Path "/terms" -ExpectBodyContains "תנאי"

Write-Host ""
if ($failed -gt 0) {
    Write-Host "$failed check(s) failed." -ForegroundColor Red
    exit 1
}

Write-Host "All smoke checks passed." -ForegroundColor Green
exit 0
