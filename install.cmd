@echo off
rem EEZ Studio MCP Server — one-double-click installer (Windows).
rem Runs installer/setup.mjs: installs the bridge extension, builds + registers the MCP
rem server with Claude Code, and copies the eez-editor agent + eez-project-editor skill.
setlocal
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [!] Node.js was not found on your PATH.
    echo       Install Node.js 18 or newer from https://nodejs.org and run this again.
    echo.
    pause
    exit /b 1
)
node "%~dp0installer\setup.mjs" %*
set EXITCODE=%errorlevel%
echo.
pause
exit /b %EXITCODE%
