@echo off
rem Prepara o computador para o InHouse (de dois cliques neste arquivo).
rem Instala o que falta (Node 24, Git, Claude Code e, se der, o GitHub CLI),
rem confere tudo e abre o InHouse. Rodar de novo e seguro. Nao pede senha.
rem O trabalho de verdade fica no scripts\windows\setup.ps1; este arquivo so o
rem chama sem esbarrar na politica de execucao de scripts do Windows.
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title InHouse - preparando o computador
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup.ps1" %*
exit /b %errorlevel%
