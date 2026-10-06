@echo off
rem Stronghold Host Panel - double-click to open the web control panel (Windows).
rem Keep this window open while hosting. Close it, or press Ctrl+C, to stop the panel
rem and everything it manages.
chcp 65001 >nul
title Stronghold Host Panel
cd /d "%~dp0"
rem private Node.js from the installer (runtime\node) comes first
if exist "%~dp0runtime\node\node.exe" set "PATH=%~dp0runtime\node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Run Install-Stronghold-Panel.bat, or install Node.js 22 or later:  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
node server.mjs
pause
