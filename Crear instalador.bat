@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Falta Node.js. Instala la version LTS desde https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules\electron call npm install --no-fund --no-audit
call npm run dist
echo.
echo Listo. El instalador esta en la carpeta "dist".
explorer dist
pause
