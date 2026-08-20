@echo off
cd /d "%~dp0"

REM V11: direct electron launch via node (skips npx entirely - npx does npm
REM resolution which is slow, may hit the network, or prompt interactively
REM and hang forever in a hidden window with no visible feedback).
REM NOTE: the recommended entry is now the desktop shortcut, which points
REM directly at node_modules\electron\dist\electron.exe (no console at all).
REM This bat is kept as the debugging entry; output goes to desktop.log.
node "%~dp0node_modules\electron\cli.js" . > "%~dp0desktop.log" 2>&1
