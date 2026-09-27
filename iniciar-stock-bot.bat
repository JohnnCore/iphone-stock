@echo off
title Vodafone Stock Bot
echo A iniciar o stock bot (corre dentro do WSL/Ubuntu)...
echo Fecha esta janela para parar o bot.
echo.
wsl.exe -d Ubuntu -- bash -ic "cd /home/joao/Code/iPhone && node stock-bot.js"
pause
