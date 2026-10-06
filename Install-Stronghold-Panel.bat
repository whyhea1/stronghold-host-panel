@echo off
rem Stronghold Host Panel installer (Windows): double-click to run install.ps1 next to this file.
rem It installs Node.js 22 if necessary, then sets up SakuraFrp frpc, the tunnel and the game.
chcp 65001 >nul
title Stronghold Host Panel - install
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
