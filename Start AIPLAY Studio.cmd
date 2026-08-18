@echo off
REM ============================================================================
REM  AIPLAY Studio — double-click this.
REM
REM  This is the whole launch story. It checks the two things that can be
REM  missing, fixes what it can, and starts the app. No terminal knowledge, no
REM  arguments, no "cd into the folder first".
REM
REM  Deliberately a .cmd and not an .exe: you can read it. A downloaded binary
REM  that wants to touch 34 GB of model weights deserves more suspicion than a
REM  fifteen-line batch file.
REM ============================================================================
setlocal
cd /d "%~dp0"
title AIPLAY Studio

echo.
echo   AIPLAY Studio
echo   -------------
echo.

REM ---- 1. Node -----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, and Studio's server is written in it.
  echo.
  echo   Get the LTS installer from https://nodejs.org  ^(about 30 MB^),
  echo   run it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM ---- 2. Dependencies ---------------------------------------------------
REM  One package, `ws`. Installed on first run so the download is small.
if not exist "node_modules\ws" (
  echo   First run — fetching one dependency ^(a few seconds^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed. Are you online?
    pause
    exit /b 1
  )
  echo.
)

REM ---- 3. Where is ComfyUI? ----------------------------------------------
REM  setup.mjs is idempotent: it exits immediately once a working engine is
REM  configured, so this costs nothing on every subsequent launch.
node scripts/setup.mjs --quiet-if-ready
if errorlevel 1 (
  echo.
  echo   Setup did not complete. Nothing was changed.
  pause
  exit /b 1
)

REM ---- 4. Go -------------------------------------------------------------
echo   Starting. Your browser will open in a moment.
echo   Leave this window open — closing it stops Studio.
echo.
start "" http://127.0.0.1:4173
node server/index.js

REM  Only reached if the server exits. Hold the window so the error is readable
REM  rather than flashing past.
echo.
echo   AIPLAY Studio stopped.
pause
