@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta Node.js. Instala la version LTS desde https://nodejs.org y vuelve a abrir este archivo.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\electron (
  echo Preparando Verso por primera vez. Tarda un par de minutos...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo No se pudo instalar. Revisa tu conexion a internet y vuelve a intentarlo.
    pause
    exit /b 1
  )
)
start "" /b npx electron .
