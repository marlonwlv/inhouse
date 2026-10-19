@echo off
rem Abre o InHouse no Windows (de dois cliques neste arquivo).
rem Na primeira vez, prepara o Node e as dependencias sozinho; o resto aparece
rem na tela de preparo do InHouse. Para fechar o InHouse, feche esta janela.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title InHouse

if "%INHOUSE_PORT%"=="" set "INHOUSE_PORT=4400"
set "FERRAMENTAS=%INHOUSE_TOOLS_DIR%"
if "%FERRAMENTAS%"=="" set "FERRAMENTAS=%USERPROFILE%\.inhouse\ferramentas"

rem Node do computador primeiro; o portatil do InHouse so quando nao houver outro.
call :nodeok
if errorlevel 1 if exist "%FERRAMENTAS%\node\node.exe" set "PATH=%FERRAMENTAS%\node;%PATH%"

call :nodeok
if errorlevel 1 goto preparar
rem Dependencias em dia com o package-lock e com o Node (muda quando o InHouse e atualizado).
node "%~dp0scripts\deps-ok.mjs"
if errorlevel 1 goto preparar
goto abrir

:preparar
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1" -Basico -NaoAbrir -SemPausa
if errorlevel 1 (
  echo.
  echo Nao deu para preparar o InHouse. Veja a mensagem acima.
  pause
  exit /b 1
)
rem O PowerShell nao devolve o PATH para esta janela: aponta para o Node portatil de novo.
call :nodeok
if errorlevel 1 set "PATH=%FERRAMENTAS%\node;%PATH%"

:abrir
rem Abre o navegador assim que o servidor responder (em segundo plano, sem janela).
start "" /b node "%~dp0scripts\windows\abrir-navegador.mjs" %INHOUSE_PORT%

echo.
echo O InHouse esta aberto no seu navegador.
echo (Feche esta janela para encerrar o InHouse.)
echo.
call npm start
echo.
echo O InHouse foi encerrado.
pause
exit /b 0

:nodeok
where node >nul 2>nul || exit /b 1
node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)" >nul 2>nul
exit /b %errorlevel%
