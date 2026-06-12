@echo off
REM RJTT Nowcaster - local launcher (Windows). Double-click to run.
cd /d %~dp0
start "" http://localhost:8080
python -m http.server 8080 2>nul || py -m http.server 8080
