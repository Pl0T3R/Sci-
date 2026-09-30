@echo off
rem Double-click to run the real Poker Night server on this computer.
rem Friends on the same Wi-Fi can join using the address shown below.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
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
call npm start -- --open
pause
