# Run Local Server (Windows PowerShell)
# Installs backend dependencies (if needed) and launches FastAPI server on http://localhost:8000

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path (Split-Path -Parent $scriptDir) "backend"

Set-Location $backendDir

Write-Host "Checking backend dependencies..." -ForegroundColor Cyan
python -m pip install -r requirements.txt

Write-Host ""
Write-Host "Starting Dam Break Inundation Modelling API & Frontend on http://localhost:8000 ..." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Yellow
Write-Host ""

python -m uvicorn app.main:app --reload --port 8000
