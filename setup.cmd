@echo off
rem Preparacao da maquina para o Inhouse no Windows (de dois cliques neste arquivo).
rem Verifica Node 24+, git, gh e o Claude Code e instala as dependencias.
rem O trabalho de verdade fica no setup.ps1 (PowerShell); este arquivo so o chama
rem sem esbarrar na politica de execucao de scripts do Windows.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1"
echo.
pause
