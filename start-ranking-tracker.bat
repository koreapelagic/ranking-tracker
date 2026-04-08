@echo off
chcp 65001 >nul 2>&1
title Ranking Tracker

echo ========================================
echo   Ranking Tracker Start
echo ========================================
echo.

set "CHROME_PATH="

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"
    goto found
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    goto found
)

echo [ERROR] Chrome not found.
pause
exit /b 1

:found
echo [1/3] Starting Chrome (debug mode)...
echo.

start "" "%CHROME_PATH%" --remote-debugging-port=9222 --user-data-dir="%~dp0chrome-debug-profile" --no-first-run --no-default-browser-check

timeout /t 4 /nobreak >nul

echo [2/3] Checking Chrome connection...

curl -s http://127.0.0.1:9222/json/version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Cannot connect to Chrome debug port.
    echo         Close ALL Chrome windows and try again.
    pause
    exit /b 1
)
echo         Chrome OK!
echo.

echo [3/3] Starting server...
echo         Dashboard: http://localhost:3000
echo ========================================
echo.

cd /d "%~dp0"
node server.js

pause
