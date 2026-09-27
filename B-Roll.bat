@echo off
rem Start EQ B-Roll Studio (the synthetic renderer). Close this window to stop it.
cd /d "%~dp0"
if exist "tools\python\python.exe" goto private
where py >NUL 2>NUL
if %errorlevel%==0 goto launcher
python broll.py serve %*
goto end
:private
"tools\python\python.exe" broll.py serve %*
goto end
:launcher
py -3 broll.py serve %*
:end
pause
