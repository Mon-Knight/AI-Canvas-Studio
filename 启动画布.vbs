Option Explicit
Dim fso, shell, scriptDir, targetVbs, argStr, i

Function QuoteArg(val)
  QuoteArg = Chr(34) & Replace(val, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
targetVbs = scriptDir & "\launch-silent.vbs"

argStr = ""
For i = 0 To WScript.Arguments.Count - 1
  argStr = argStr & " " & QuoteArg(WScript.Arguments(i))
Next

WScript.Quit shell.Run("wscript.exe //NoLogo " & QuoteArg(targetVbs) & argStr, 0, True)
