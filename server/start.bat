@echo off
cd /d "%~dp0"
rem Disable authentication for local dev when starting via this script
set "DISABLE_AUTH=1"
node server.cjs
pause
