@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Add bin folder to path for this session
set "PATH=%~dp0bin;%PATH%"

:: Check if all 3 portable binaries exist in bin\
set "MISSING_BIN="
if not exist "%~dp0bin\node.exe" set "MISSING_BIN=1"
if not exist "%~dp0bin\mpv.exe" set "MISSING_BIN=1"
if not exist "%~dp0bin\yt-dlp.exe" set "MISSING_BIN=1"

if defined MISSING_BIN (
    cls
    echo ======================================================================
    echo                     YTSync - First-Time Setup
    echo ======================================================================
    echo.
    echo  Required portable binaries (Node.js, MPV, yt-dlp) were not found in:
    echo    %~dp0bin\
    echo.
    echo  YTSync can automatically download and configure all dependencies
    echo  with zero manual installation required.
    echo.
    set /p INSTALL_CHOICE="  Would you like to automatically download them now? (Y/N): "
    if /i "!INSTALL_CHOICE!"=="Y" (
        echo.
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
        if errorlevel 1 (
            echo.
            echo [!] Download failed. Please check your internet connection.
            pause
            exit /b 1
        )
    ) else (
        echo.
        echo  Skipping portable download. Trying system tools if installed...
        echo.
    )
)

:: Run portable node if present, else fallback to system node
if exist "%~dp0bin\node.exe" (
    "%~dp0bin\node.exe" src\index.js %*
) else (
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
)

if errorlevel 1 (
    echo.
    echo YTSync exited with an error.
    pause
)
