@echo off
rem Stronghold Host Panel - double-click to open the web control panel (Windows).
rem Keep this window open while hosting. Close it, or press Ctrl+C, to stop the panel
rem and everything it manages.
chcp 65001 >nul
title Stronghold Host Panel
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 22 or later:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node server.mjs
pause
