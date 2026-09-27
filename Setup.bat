@echo off
rem EQ B-Roll: one-time setup for filming in the real EverQuest client on a local server.
rem Safe to run again any time.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1" %*
echo.
pause
