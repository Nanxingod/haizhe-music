# HaiZhe Music - desktop shortcut generator (V11)
# Target: electron.exe directly - a GUI binary, so NO console window ever pops up,
# and the whole fragile chain (wscript -> vbs -> bat -> npx -> node) is bypassed.
# npx could hang forever resolving packages (observed 2026-08-20: bat never even
# ran, desktop.log untouched, app "would not open").
$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath("Desktop")
$Electron = "$PSScriptRoot\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $Electron)) { Write-Error "electron.exe not found: $Electron"; exit 1 }

$Shortcut = $WshShell.CreateShortcut("$Desktop\HaiZhe Music.lnk")
$Shortcut.TargetPath = $Electron
$Shortcut.Arguments = '"{0}"' -f $PSScriptRoot
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.IconLocation = "$PSScriptRoot\electron\icon.ico,0"
$Shortcut.Save()
Write-Host "Shortcut created: direct electron.exe launch, custom icon"
