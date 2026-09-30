@echo off
rem Double-click to host Poker Night on this computer for friends on ANY network.
rem It starts the server plus a free Cloudflare tunnel and prints a public link.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set "HAVE_CF="
where cloudflared >nul 2>nul && set "HAVE_CF=1"
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "HAVE_CF=1"
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "HAVE_CF=1"
if not defined HAVE_CF (
  echo Installing Cloudflare Tunnel ^(cloudflared^), this is needed only once...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo Could not install cloudflared automatically.
    echo Open Terminal and run:  winget install --id Cloudflare.cloudflared
    echo Then start this file again.
    pause
    exit /b 1
  )
)
call npm run online
pause
