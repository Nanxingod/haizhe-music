@echo off
title HaiZhe Music
cd /d "%~dp0"

REM Kill old backend on port 8765
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8765') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo Starting HaiZhe Music...

REM Backend: run silently (no visible window)
start "HB" /b /min cmd /c "cd /d %~dp0backend && python main.py >nul 2>&1"

REM Wait for backend
timeout /t 3 /nobreak >nul

REM Frontend: run silently
start "HF" /b /min cmd /c "cd /d %~dp0frontend && npx vite --host 0.0.0.0 >nul 2>&1"

timeout /t 2 /nobreak >nul
start http://localhost:5173

echo Done! http://localhost:5173
echo Close this window to keep music running.

pause >nul
