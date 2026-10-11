@echo off
setlocal
cd /d "%~dp0"

:: Add bin folder to path for this session
set "PATH=%~dp0bin;%PATH%"

:: Check if all 3 portable binaries exist in bin\
if not exist "%~dp0bin\node.exe" goto :missing_binaries
if not exist "%~dp0bin\mpv.exe" goto :missing_binaries
if not exist "%~dp0bin\yt-dlp.exe" goto :missing_binaries
goto :run_app

:missing_binaries
cls
echo ======================================================================
echo                     YTSync - First-Time Setup
echo ======================================================================
echo.
echo  Required portable binaries [Node.js, MPV, yt-dlp] were not found in:
echo    %~dp0bin\
echo.
echo  YTSync can automatically download and configure all dependencies
echo  with zero manual installation required.
echo.
set /p INSTALL_CHOICE="  Would you like to automatically download them now? [Y/N]: "
if /i not "%INSTALL_CHOICE%"=="Y" goto :skip_download

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
if errorlevel 1 (
    echo.
    echo [!] Download failed. Please check your internet connection.
    pause
    exit /b 1
)
goto :run_app

:skip_download
echo.
echo  Skipping portable download. Trying system tools if installed...
echo.

:run_app
if exist "%~dp0bin\node.exe" (
    "%~dp0bin\node.exe" src\index.js %*
    goto :end
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [!] Error: Node.js is not installed and portable binary was not found.
    echo     Run start.bat again and select 'Y' to download portable tools.
    echo.
    pause
    exit /b 1
)

node src\index.js %*

:end
if errorlevel 1 (
    echo.
    echo YTSync exited with an error.
    pause
)
