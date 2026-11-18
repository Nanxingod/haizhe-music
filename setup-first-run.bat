@echo off
chcp 65001 >nul
setlocal EnableExtensions
title HaiZhe Music - First Setup
cd /d "%~dp0"

echo ==========================================
echo   HaiZhe Music - First Setup
echo ==========================================
echo   Requires: Python 3.9+ and Node.js 18+
echo.
echo   This will:
echo     1. create .venv and install backend deps
echo     2. install Electron / frontend deps
echo     3. generate backend\config.json
echo     4. optionally create a desktop shortcut
echo.
pause

set "ROOT=%~dp0"
set "MIRROR="

REM ---------- [1/6] Python ----------
set "PYCMD="
where py >nul 2>&1 && set "PYCMD=py -3"
if not defined PYCMD (
    where python >nul 2>&1 && set "PYCMD=python"
)
if not defined PYCMD (
    echo [ERROR] Python not found. Install Python 3.9+ first:
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
)
%PYCMD% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 (
    echo [ERROR] Python 3.9 or newer is required.
    pause
    exit /b 1
)
echo [1/6] Python: OK

REM ---------- [2/6] venv ----------
if exist "%ROOT%.venv\Scripts\python.exe" (
    echo [2/6] .venv already exists - reusing it
) else (
    echo [2/6] Creating .venv ...
    %PYCMD% -m venv "%ROOT%.venv"
    if errorlevel 1 (
        echo [ERROR] Could not create .venv
        pause
        exit /b 1
    )
)
set "VPY=%ROOT%.venv\Scripts\python.exe"

REM ---------- mirror choice ----------
echo.
set /p "ANS=Use China mirrors for pip / npm / Electron? [Y/n] "
if /i "%ANS%"=="n" (
    set "MIRROR="
) else (
    set "MIRROR=1"
)

REM ---------- [3/6] backend deps ----------
echo.
echo [3/6] Installing backend dependencies ...
"%VPY%" -m pip install --upgrade pip --quiet
if defined MIRROR (
    "%VPY%" -m pip install -r backend\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
) else (
    "%VPY%" -m pip install -r backend\requirements.txt
)
if errorlevel 1 (
    echo.
    echo [ERROR] pip install failed. If the network is restricted, re-run and
    echo         choose the mirror, or run manually:
    echo         .venv\Scripts\python.exe -m pip install -r backend\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    pause
    exit /b 1
)

REM ---------- [4/6] node deps ----------
echo.
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js / npm not found. Install Node.js 18+ first:
    echo         https://nodejs.org/
    pause
    exit /b 1
)
if defined MIRROR (
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
)
echo [4/6] Installing Electron / frontend dependencies ...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] npm install failed. Re-run and choose the mirror, or run:
    echo         npm install --registry=https://registry.npmmirror.com
    pause
    exit /b 1
)
pushd "%ROOT%frontend"
call npm install --no-audit --no-fund
if errorlevel 1 (
    popd
    echo [ERROR] frontend npm install failed.
    pause
    exit /b 1
)
popd

REM npm may skip the Electron binary on restricted networks. Detect and retry once.
if not exist "%ROOT%node_modules\electron\dist\electron.exe" (
    echo.
    echo [!] electron.exe was not downloaded ^(common on restricted networks^).
    echo     Retrying with ELECTRON_MIRROR ...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    call npm install electron --no-audit --no-fund
)

REM ---------- [5/6] config ----------
echo.
if exist "%ROOT%backend\config.json" (
    echo [5/6] backend\config.json exists - kept as is
) else (
    copy /y "%ROOT%backend\config.example.json" "%ROOT%backend\config.json" >nul
    echo [5/6] Created backend\config.json - set your music folder on first launch
)

REM ---------- [6/6] shortcut ----------
echo.
set /p "MK=Create a desktop shortcut? [Y/n] "
if /i "%MK%"=="n" (
    echo [6/6] Skipped shortcut
) else (
    if exist "%ROOT%node_modules\electron\dist\electron.exe" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%create-shortcut.ps1"
        echo [6/6] Shortcut created on Desktop
    ) else (
        echo [6/6] Skipped: electron.exe missing (see mirror hint above)
    )
)

echo.
echo ==========================================
echo   Setup complete
echo.
echo   Start the desktop app : double-click the desktop shortcut
echo                           (or start-desktop.bat)
echo   Start in the browser  : start.bat  -^>  http://localhost:5173
echo.
echo   The first launch shows a 3-step setup wizard:
echo     music folder  ^-^>  optional AI key  ^-^>  done
echo ==========================================
pause
