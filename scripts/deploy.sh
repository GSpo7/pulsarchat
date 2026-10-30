#!/usr/bin/env bash
set -euo pipefail
cd /opt/pulsarchat
git fetch origin main
git merge --ff-only origin/main
npm ci
npm run build
sudo systemctl restart pulsarchat
sleep 2
curl -fsS http://127.0.0.1:9000/api/health && echo " deploy ok"
