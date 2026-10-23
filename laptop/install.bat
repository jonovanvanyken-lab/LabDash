@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python is not installed or not on PATH. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b)
echo Installing helper packages...
python -m pip install --user --quiet --disable-pip-version-check keyring cryptography openpyxl
python labdash_sync.py setup
echo.
pause
