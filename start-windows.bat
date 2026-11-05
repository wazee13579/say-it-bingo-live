@echo off
cd /d "%~dp0"
node --version >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 20 or newer first from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Say It! Bingo at http://localhost:3000
npm start
pause
