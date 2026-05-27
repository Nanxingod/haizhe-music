@echo off
chcp 65001 >nul
echo ================================
echo   HaiZhe Music - First Setup
echo ================================
echo.
echo This will install Python dependencies.
echo Python 3.9+ is required.
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found! Please install Python 3.9+
    echo https://www.python.org/downloads/
    pause
    exit /b 1
)

echo Installing dependencies...
pip install fastapi uvicorn mutagen aiofiles
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install. Check network.
    pause
    exit /b 1
)

echo.
echo ================================
echo   Setup complete!
echo.
echo   1. Edit backend\config.json to set your music folder
echo   2. Double-click start-desktop.bat to launch
echo ================================
pause
