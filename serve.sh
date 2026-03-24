#!/bin/bash
# Simple HTTP server for WardrobeApp
# Access from your iPhone: find your Mac's IP with `ifconfig | grep inet`
# Then open http://<your-mac-ip>:8080 in Safari on your iPhone

PORT=${1:-8080}
echo ""
echo "  WardrobeApp running at:"
echo "  http://localhost:$PORT"
echo ""
echo "  To access from iPhone on the same Wi-Fi:"
IP=$(ipconfig getifaddr en0 2>/dev/null || echo "check ifconfig")
echo "  http://$IP:$PORT"
echo ""
echo "  In Safari, tap Share → Add to Home Screen"
echo ""

cd "$(dirname "$0")"
python3 -m http.server "$PORT"
