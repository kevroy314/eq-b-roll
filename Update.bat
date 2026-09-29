@echo off
rem EQ B-Roll: update to the latest version. Keeps your zones, takes, renders and settings.
rem Close the Studio window first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\update.ps1" %*
echo.
pause
