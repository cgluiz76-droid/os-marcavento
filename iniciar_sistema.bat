@echo off
title Sistema O.S. Marca Vento - Moskit CRM
color 0E

echo ============================================================
echo   SISTEMA DE O.S. MARCA VENTO - INTEGRACAO COM MOSKIT CRM
echo ============================================================
echo.
echo Verificando dependencias e iniciando servidor na porta 3000...
echo O navegador abrira automaticamente em: http://localhost:3000
echo.
echo Para encerrar o sistema, basta fechar esta janela.
echo ============================================================
echo.

start "" http://localhost:3000
node server.js

pause
