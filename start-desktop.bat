@echo off
chcp 65001 >nul
cd /d "%~dp0launcher\desktop"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Comfy Infinity] 首次运行，正在安装桌面外壳依赖...
  call npm install
  if errorlevel 1 (
    echo [Comfy Infinity] 依赖安装失败，请检查 npm 与网络后重试。
    pause
    exit /b 1
  )
)

start "" "%~dp0launcher\desktop\node_modules\electron\dist\electron.exe" "%~dp0launcher\desktop"
