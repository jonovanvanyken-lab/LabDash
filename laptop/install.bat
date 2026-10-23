@echo off
cd /d "%~dp0"
python -m pip install --user --quiet keyring cryptography openpyxl
python labdash_sync.py setup
pause
