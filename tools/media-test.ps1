<#
  Haizhe Music - media session inspector / media key tester

  Usage (run from project root):
    media-test.ps1 list        only list media sessions (sends nothing)
    media-test.ps1 playpause   send one Play/Pause media key, then list
    media-test.ps1 next        send Next Track
    media-test.ps1 prev        send Previous Track
    media-test.ps1 seekfwd     send Fast Forward

  Note: output is English on purpose - PowerShell 5.1 reads .ps1 as ANSI
  when the file has no BOM, which garbles Chinese text.
#>
param([string]$Action = "list")

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $t) {
  $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MediaKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Send(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
"@

switch ($Action.ToLower()) {
  "playpause" { [MediaKey]::Send(0xB3); Write-Host "sent: PLAY/PAUSE" -ForegroundColor Yellow }
  "next"      { [MediaKey]::Send(0xB0); Write-Host "sent: NEXT TRACK" -ForegroundColor Yellow }
  "prev"      { [MediaKey]::Send(0xB1); Write-Host "sent: PREV TRACK" -ForegroundColor Yellow }
  "seekfwd"   { [MediaKey]::Send(0xB5); Write-Host "sent: FAST FORWARD" -ForegroundColor Yellow }
  default     { Write-Host "inspect only, no key sent" -ForegroundColor DarkGray }
}

Start-Sleep -Milliseconds 700

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions = $mgr.GetSessions()

Write-Host ""
Write-Host ("media sessions: " + $sessions.Count) -ForegroundColor Cyan
foreach ($s in $sessions) {
  $info = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $pb = $s.GetPlaybackInfo()
  Write-Host ("  app    : " + $s.SourceAppUserModelId)
  Write-Host ("  track  : " + $info.Title + " - " + $info.Artist)
  Write-Host ("  state  : " + $pb.PlaybackStatus)
  Write-Host ""
}
if ($sessions.Count -eq 0) {
  Write-Host "(no session = nothing is playing right now, or the player never registered)" -ForegroundColor DarkYellow
}
