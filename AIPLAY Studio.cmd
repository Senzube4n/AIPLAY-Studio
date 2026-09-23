@echo off
REM ============================================================================
REM  AIPLAY Studio - the launcher. Double-click this.
REM
REM  Opens one window with both launch modes (Full Studio, Music only) and a
REM  system check: graphics card, CUDA or ROCm, ComfyUI, models, YuE2.
REM  Studio is opened in your browser only once ComfyUI reports it is ready.
REM
REM  Still a readable .cmd: it checks Node.js and the npm packages, then
REM  runs launcher\launcher.mjs, which you can read too. This console is the
REM  launcher itself; closing it stops Studio.
REM ============================================================================
setlocal
cd /d "%~dp0"
title AIPLAY Studio launcher

REM A private Node.js from AIPLAY Studio Setup.exe comes first, for this window only.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, and Studio's server is written in it.
  echo   Get the LTS installer from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node -e "if(20 > Number(process.versions.node.split('.')[0]))process.exit(1)"
if errorlevel 1 (
  echo   Please update Node.js to version 20 or newer.
  pause
  exit /b 1
)

if not exist "node_modules\ws" goto :deps
if not exist "node_modules\three" goto :deps
if not exist "node_modules\gltf-validator" goto :deps
if not exist "node_modules\@pixiv\three-vrm" goto :deps
goto :ready
:deps
echo   Fetching dependencies (a few seconds)...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo   npm install failed. Are you online?
  pause
  exit /b 1
)
:ready
echo.
echo   AIPLAY Studio launcher
echo   ----------------------
echo   Opening the launcher window. Leave this console open while Studio runs.
echo.
node launcher\launcher.mjs
if errorlevel 1 pause
