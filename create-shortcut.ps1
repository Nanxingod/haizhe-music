$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath("Desktop")
$Shortcut = $WshShell.CreateShortcut("$Desktop\HaiZhe Music.lnk")
$Shortcut.TargetPath = "D:\agentspace\music-player\start-desktop.bat"
$Shortcut.WorkingDirectory = "D:\agentspace\music-player"
$Shortcut.IconLocation = "D:\agentspace\music-player\electron\icon.ico"
$Shortcut.Save()
Write-Host "Shortcut updated with custom icon"
