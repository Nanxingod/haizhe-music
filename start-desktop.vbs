' HaiZhe Music - silent launcher (no console window)
' Shortcut -> wscript.exe this script -> runs start-desktop.bat fully hidden.
' NOTE: keep this file ASCII-only! wscript reads .vbs as ANSI (GBK on zh-CN),
' UTF-8 Chinese comments corrupt parsing (e.g. "Object required: 'fso'").
' Fix history: the old script used batch syntax %~dp0 (never expanded in VBS),
' so a cmd console always popped up and closing it killed the whole app.
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & strDir & "\start-desktop.bat""", 0, False
