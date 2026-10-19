@echo off
rem Abre o Inhouse no Windows (de dois cliques neste arquivo).
rem Sobe o servidor local e abre o navegador em http://127.0.0.1:4400.
rem Para fechar o Inhouse, feche esta janela.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Inhouse

if "%INHOUSE_PORT%"=="" set "INHOUSE_PORT=4400"

where node >nul 2>nul
if errorlevel 1 goto semnode
node -e "process.exit(+process.versions.node.split('.')[0]>=24?0:1)"
if errorlevel 1 goto semnode

if not exist "node_modules\" (
  echo Primeira vez por aqui: rode antes o setup.cmd ^(dois cliques^).
  pause
  exit /b 1
)

rem Abre o navegador assim que o servidor responder (em segundo plano, sem janela).
start "" /b node "%~dp0scripts\windows\abrir-navegador.mjs" %INHOUSE_PORT%

echo Abrindo o Inhouse em http://127.0.0.1:%INHOUSE_PORT% ...
echo (Feche esta janela para encerrar o Inhouse.)
echo.
call npm start
echo.
echo O Inhouse foi encerrado.
pause
exit /b 0

:semnode
echo Nao encontrei o Node 24 nesta maquina. Rode primeiro o setup.cmd ^(dois cliques^).
pause
exit /b 1
