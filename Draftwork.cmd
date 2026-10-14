@echo off
title Draftwork
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Draftwork needs Node.js 20 or newer. Download it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node launch.js %*
if errorlevel 1 pause
