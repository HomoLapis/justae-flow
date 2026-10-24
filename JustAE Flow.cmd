@echo off
rem JustAE Flow: the server, EffectCraft with its control channel, and the Flow window docked beside it.
cd /d "%~dp0"
where node >nul 2>&1 || (echo JustAE Flow needs Node.js 22.18 or newer: https://nodejs.org & pause & exit /b 1)
node scripts\launch.ts
if errorlevel 1 pause
