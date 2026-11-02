@echo off
chcp 65001 >nul
cd /d "%~dp0launcher\desktop"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Comfy Infinity] First run, installing desktop shell dependencies...
  call npm install
  if errorlevel 1 (
    echo [Comfy Infinity] Dependency installation failed. Please check npm and your network, then try again.
    exit /b 1
  )
)

start "" "%~dp0launcher\desktop\node_modules\electron\dist\electron.exe" "%~dp0launcher\desktop"