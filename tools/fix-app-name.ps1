<#
  Haizhe Music - fix "Unknown app" on the Windows media card (SMTC)

  Why: Windows resolves the media card's app name by looking up the AUMID in
  Start Menu shortcuts. Running electron.exe directly (dev mode) has no such
  shortcut, so it always shows "Unknown app". The registry DisplayName is only
  used by toast notifications, not by SMTC.

  What it does:
    1. creates  %APPDATA%\...\Start Menu\Programs\<name>.lnk  (points to start-desktop.vbs)
    2. sets     System.AppUserModel.ID = com.haizhe.music  on that shortcut
    3. also writes HKCU\Software\Classes\AppUserModelId\com.haizhe.music (DisplayName/IconUri)

  Then restart the player and the card should show the app name.

  Run:
    powershell -ExecutionPolicy Bypass -File tools\fix-app-name.ps1
#>

$ErrorActionPreference = 'Stop'
$APP_ID = 'com.haizhe.music'
# 海蜇音乐 - keep this file ASCII-only, build the Chinese name from code points
$APP_NAME = -join ([char]0x6D77, [char]0x86F0, [char]0x97F3, [char]0x4E50)

$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $root 'start-desktop.vbs'
$ico  = Join-Path $root 'electron\icon.ico'
if (-not (Test-Path $vbs)) { throw "start-desktop.vbs not found: $vbs" }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ShortcutAumid {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(
        string path, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore ppv);

    public static void Set(string lnkPath, string aumid) {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);

        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
        key.pid = 5;

        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31; // VT_LPWSTR
        pv.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
        try {
            store.SetValue(ref key, ref pv);
            store.Commit();
        } finally {
            Marshal.FreeCoTaskMem(pv.pointerValue);
        }
    }
}
"@

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $startMenu ($APP_NAME + '.lnk')

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $root
if (Test-Path $ico) { $sc.IconLocation = $ico + ',0' }
$sc.Description = $APP_NAME
$sc.Save()

[ShortcutAumid]::Set($lnk, $APP_ID)

$key = "HKCU:\Software\Classes\AppUserModelId\$APP_ID"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name 'DisplayName' -Value $APP_NAME -Force
if (Test-Path $ico) { Set-ItemProperty -Path $key -Name 'IconUri' -Value $ico -Force }

Write-Host ""
Write-Host "done." -ForegroundColor Green
Write-Host ("  shortcut : " + $lnk)
Write-Host ("  aumid    : " + $APP_ID)
Write-Host ""
Write-Host "restart the player, then check the volume flyout card again." -ForegroundColor Cyan
