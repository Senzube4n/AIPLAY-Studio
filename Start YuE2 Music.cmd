@echo off
setlocal
cd /d "%~dp0"
title AIPLAY Studio - YuE2 Music
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 20 or newer from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node -e "if(20 > Number(process.versions.node.split('.')[0]))process.exit(1)"
if errorlevel 1 (
  echo Please update Node.js to version 20 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\ws" goto :deps
if not exist "node_modules\three" goto :deps
if not exist "node_modules\gltf-validator" goto :deps
goto :ready
:deps
call npm ci --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo Dependency installation failed. Check your internet connection.
  pause
  exit /b 1
)
:ready
echo Starting native music mode. No ComfyUI or other models required.
echo Open Models, choose YuE2 GGUF setup, review the terms, then install.
echo Leave this window open while Studio is running.
set AIPLAY_OPEN=1
node scripts/start-music.mjs
pause
