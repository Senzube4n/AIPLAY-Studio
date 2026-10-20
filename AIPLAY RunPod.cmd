@echo off
setlocal
cd /d "%~dp0"
title AIPLAY Studio - RunPod GPU
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node -e "if(22 > Number(process.versions.node.split('.')[0]))process.exit(1)"
if errorlevel 1 (
  echo Please update Node.js to version 22 or newer.
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
set "AIPLAY_OPEN=1"
echo Opening AIPLAY Studio in RunPod GPU mode. Keep this window open while using AIPLAY.
echo Closing it does not stop the remote Pod or its billing.
node scripts\start-remote.mjs
if errorlevel 1 pause
