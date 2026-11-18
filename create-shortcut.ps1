# HaiZhe Music - desktop shortcut generator (V15.2)
#
# Target: electron.exe directly - a GUI binary, so NO console window ever pops up,
# and the whole fragile chain (wscript -> vbs -> bat -> npx -> node) is bypassed.
# npx could hang forever resolving packages (observed 2026-08-20: bat never even
# ran, desktop.log untouched, app "would not open").
#
# Idempotent: the shortcut path is fixed, so re-running overwrites it instead of
# creating "HaiZhe Music (2).lnk".
#
# Optional: -WithWeb also creates a browser-mode shortcut pointing at start.bat,
# useful when Electron itself is broken or the binary failed to download.
param([switch]$WithWeb)

$ErrorActionPreference = "Stop"
$WshShell = New-Object -ComObject WScript.Shell
$Desktop  = [Environment]::GetFolderPath("Desktop")
$Electron = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$Icon     = Join-Path $PSScriptRoot "electron\icon.ico"

if (-not (Test-Path $Electron)) {
    Write-Host ""
    Write-Host "[!] electron.exe not found:" -ForegroundColor Yellow
    Write-Host "    $Electron" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "    npm install may have skipped the Electron binary on a restricted network." -ForegroundColor Yellow
    Write-Host "    Retry with a mirror, then run this script again:" -ForegroundColor Yellow
    Write-Host "      `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'" -ForegroundColor Cyan
    Write-Host "      npm install electron" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}

$Link = Join-Path $Desktop "HaiZhe Music.lnk"
$Shortcut = $WshShell.CreateShortcut($Link)
$Shortcut.TargetPath       = $Electron
$Shortcut.Arguments        = '"{0}"' -f $PSScriptRoot
$Shortcut.WorkingDirectory = $PSScriptRoot
if (Test-Path $Icon) { $Shortcut.IconLocation = "$Icon,0" }
$Shortcut.Description      = "HaiZhe Music - local music player"
$Shortcut.Save()
Write-Host "Shortcut ready: $Link" -ForegroundColor Green

if ($WithWeb) {
    $WebBat = Join-Path $PSScriptRoot "start.bat"
    if (Test-Path $WebBat) {
        $WebLink = Join-Path $Desktop "HaiZhe Music (Web).lnk"
        $s = $WshShell.CreateShortcut($WebLink)
        $s.TargetPath       = $WebBat
        $s.WorkingDirectory = $PSScriptRoot
        if (Test-Path $Icon) { $s.IconLocation = "$Icon,0" }
        $s.Description      = "HaiZhe Music - browser mode (http://localhost:5173)"
        $s.Save()
        Write-Host "Shortcut ready: $WebLink" -ForegroundColor Green
    }
}
