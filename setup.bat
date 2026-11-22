@echo off
cd /d "%~dp0"
echo ====================================================
echo   Gakumon - 1-Click Environment and Model Setup
echo ====================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python 3.10+ was not found in PATH.
    echo Please install Python from https://www.python.org/downloads/
    echo and check "Add python.exe to PATH".
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [Step 1] Creating Python virtual environment ^(.venv^)...
    python -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create .venv.
        pause
        exit /b 1
    )
)

echo [Step 2] Installing required Python packages...
".venv\Scripts\python.exe" -m pip install --no-cache-dir --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install --no-cache-dir -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install Python packages.
    pause
    exit /b 1
)

echo.
echo [Step 3] Downloading llama.cpp runtime and Gemma 4 / EmbeddingGemma 2 models...
echo (First time may take several minutes depending on your internet speed.)
".venv\Scripts\python.exe" scripts\setup_env.py %*
if errorlevel 1 (
    echo [ERROR] Setup failed. Check the messages above.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   Setup Complete! Double-click start.bat to launch.
echo ====================================================
pause
