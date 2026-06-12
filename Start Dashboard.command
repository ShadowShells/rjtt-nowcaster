#!/bin/bash
# RJTT Nowcaster — local launcher (Mac)
# Double-click this file. It starts a tiny local web server and opens the dashboard.
# Keep this window open while using the dashboard; close it to stop.
cd "$(dirname "$0")"
PORT=8080
( sleep 1; open "http://localhost:$PORT" ) &
echo "RJTT Nowcaster running at http://localhost:$PORT"
echo "Keep this window open. Press Ctrl+C or close the window to stop."
python3 -m http.server $PORT
