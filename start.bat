@echo off
chcp 65001 >nul
title HaiZhe Music (Web)
cd /d "%~dp0"
setlocal EnableExtensions

set "ROOT=%~dp0"
set "PY=%ROOT%.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
set "HAVE_CURL=0"
where curl >nul 2>&1 && set "HAVE_CURL=1"

echo Starting HaiZhe Music (browser mode)...

REM -- [1/4] backend dependencies --
"%PY%" -c "import fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Backend dependencies are missing for: %PY%
    echo         Run setup-first-run.bat first.
    echo.
    pause
    exit /b 1
)

REM -- [2/4] port 8765 --
REM Ask "is our own backend already running?" first: reuse it instead of
REM taskkilling whatever happens to hold the port (that used to kill unrelated apps).
set "REUSE=0"
if "%HAVE_CURL%"=="1" (
    curl -s -m 2 http://127.0.0.1:8765/api/status >nul 2>&1
    if not errorlevel 1 set "REUSE=1"
)

if "%REUSE%"=="1" (
    echo [i] Backend already running on 8765 - reusing it.
) else (
    set "OCCUPIED="
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do set "OCCUPIED=%%a"
    if defined OCCUPIED (
        echo.
        echo [!] Port 8765 is occupied by PID %OCCUPIED%, but it does not answer as HaiZhe backend.
        echo     Close that program, or run:  taskkill /f /pid %OCCUPIED%
        echo.
        pause
        exit /b 1
    )
    echo [2/4] Starting backend...
    pushd "%ROOT%backend"
    start "HaiZheBackend" /b /min "%PY%" main.py > NUL 2>&1
    popd
)

REM -- [3/4] frontend --
if not exist "%ROOT%frontend\node_modules\.bin\vite.cmd" (
    echo.
    echo [ERROR] Frontend dependencies missing: frontend\node_modules
    echo         Run setup-first-run.bat first.
    echo.
    pause
    exit /b 1
)
echo [3/4] Starting frontend...
pushd "%ROOT%frontend"
start "HaiZheFrontend" /b /min cmd /c "node_modules\.bin\vite.cmd --host 127.0.0.1"
popd

REM -- [4/4] wait until ready, then open the browser --
echo [4/4] Waiting for http://localhost:5173 ...
if "%HAVE_CURL%"=="1" (
    for /l %%i in (1,1,40) do (
        curl -s -m 1 http://127.0.0.1:5173 >nul 2>&1 && goto READY
        timeout /t 1 /nobreak >nul
    )
    echo [!] Frontend did not respond in 40s - check logs, or run: npm run dev
    pause
    exit /b 1
) else (
    timeout /t 4 /nobreak >nul
)

:READY
start "" http://localhost:5173
echo.
echo Done. http://localhost:5173
echo For detailed backend logs use the desktop app (logs\backend.log).
echo Keep this window open while using browser mode (closing it stops the servers).
pause >nul
