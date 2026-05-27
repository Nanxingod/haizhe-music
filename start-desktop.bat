@echo off
cd /d "%~dp0"

REM Kill any leftover services on our ports
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8765') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173') do taskkill /f /pid %%a >nul 2>&1

REM Electron manages backend + frontend automatically
start "" /b npx electron .
exit
