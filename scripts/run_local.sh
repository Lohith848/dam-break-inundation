#!/usr/bin/env bash
# Convenience script: installs backend deps and starts the unified API & Frontend server.
set -e
cd "$(dirname "$0")/../backend"
python3 -m pip install -r requirements.txt || pip install --break-system-packages -r requirements.txt
echo ""
echo "Starting Dam Break Inundation Modelling Server on http://localhost:8000 ..."
echo "API endpoints and static frontend are served together on port 8000."
python3 -m uvicorn app.main:app --reload --port 8000

