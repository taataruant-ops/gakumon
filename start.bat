@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start Gakumon. If this is your first time, run setup.bat first.
    pause
    exit /b 1
)
echo.
echo Opening https://127.0.0.1:8000 in your browser...
start "" "https://127.0.0.1:8000"
pause
