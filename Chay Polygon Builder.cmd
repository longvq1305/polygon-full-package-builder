@echo off
setlocal
chcp 65001 >nul
title Polygon Full Package Builder

cd /d "%~dp0"
set "APP_URL=http://127.0.0.1:4173"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [LOI] Khong tim thay Node.js tren may.
  echo Hay cai Node.js 20 tro len tu https://nodejs.org/ roi chay lai file nay.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing '%APP_URL%/api/health' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo Tool dang chay. Dang mo trinh duyet...
  start "" "%APP_URL%"
  exit /b 0
)

echo.
echo ============================================================
echo   POLYGON FULL PACKAGE BUILDER
echo ============================================================
echo.
echo Dang khoi dong tool...
echo Khi trinh duyet mo, hay giu cua so nay dang chay.
echo Dong cua so nay khi ban muon tat tool.
echo.

start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$deadline = (Get-Date).AddSeconds(20); while ((Get-Date) -lt $deadline) { try { $response = Invoke-WebRequest -UseBasicParsing '%APP_URL%/api/health' -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process '%APP_URL%'; exit 0 } } catch {}; Start-Sleep -Milliseconds 300 }; exit 1" >nul 2>nul

node src/server.js
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [LOI] Tool da dung voi ma loi %EXIT_CODE%.
  echo Hay chup lai noi dung cua so nay neu ban can ho tro.
  echo.
  pause
)

exit /b %EXIT_CODE%
