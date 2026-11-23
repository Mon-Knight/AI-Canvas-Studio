Option Explicit
Dim fso, shell, procEnv, scriptDir, desktopDir, electronExe, desktopMain, frontendIndex, launcherScript, logPath
Dim isWebMode, checkOnly, fullArgStr, extraArgStr, i, arg, cmdLine, nodeExe, exitCode, errNum, errDesc
Dim candidates, c, expanded

Function QuoteArg(val)
  QuoteArg = Chr(34) & Replace(val, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = scriptDir & "\desktop"
electronExe = desktopDir & "\node_modules\electron\dist\electron.exe"
desktopMain = desktopDir & "\dist\main.js"
frontendIndex = scriptDir & "\frontend\dist\index.html"
launcherScript = scriptDir & "\scripts\silent-launcher.mjs"
logPath = scriptDir & "\storage\launcher.log"

isWebMode = False
checkOnly = False
fullArgStr = ""
extraArgStr = ""

If WScript.Arguments.Count > 0 Then
  For i = 0 To WScript.Arguments.Count - 1
    arg = WScript.Arguments(i)
    If LCase(arg) = "--web" Then
      isWebMode = True
      fullArgStr = fullArgStr & " " & QuoteArg(arg)
    ElseIf LCase(arg) = "--desktop" Then
      fullArgStr = fullArgStr & " " & QuoteArg(arg)
    ElseIf LCase(arg) = "--check-vbs" Then
      checkOnly = True
    Else
      fullArgStr = fullArgStr & " " & QuoteArg(arg)
      extraArgStr = extraArgStr & " " & QuoteArg(arg)
    End If
  Next
End If

If Trim(fullArgStr) = "" Then
  fullArgStr = " --desktop"
End If

If checkOnly Then
  If fso.FileExists(electronExe) And fso.FileExists(desktopMain) And fso.FileExists(frontendIndex) And fso.FileExists(launcherScript) Then
    WScript.Quit 0
  Else
    WScript.Quit 2
  End If
End If

On Error Resume Next
Set procEnv = shell.Environment("PROCESS")
procEnv.Remove "ELECTRON_RUN_AS_NODE"
Err.Clear
On Error GoTo 0

' Fast direct GUI path: launch Electron immediately without hidden Node hop
If (Not isWebMode) And fso.FileExists(electronExe) And fso.FileExists(desktopMain) And fso.FileExists(frontendIndex) Then
  shell.CurrentDirectory = desktopDir
  cmdLine = QuoteArg(electronExe) & " " & QuoteArg(desktopDir) & extraArgStr
  On Error Resume Next
  shell.Run cmdLine, 1, False
  errNum = Err.Number
  Err.Clear
  On Error GoTo 0
  If errNum = 0 Then
    WScript.Quit 0
  End If
End If

' Fallback bootstrap path (--web or missing dist/electron build)
nodeExe = "node.exe"
candidates = Array("%ProgramFiles%\nodejs\node.exe", "%ProgramFiles(x86)%\nodejs\node.exe", "%LocalAppData%\Programs\nodejs\node.exe", "%NVM_SYMLINK%\node.exe")
For Each c In candidates
  expanded = shell.ExpandEnvironmentStrings(c)
  If InStr(expanded, "%") = 0 Then
    If fso.FileExists(expanded) Then
      nodeExe = expanded
      Exit For
    End If
  End If
Next

cmdLine = QuoteArg(nodeExe) & " " & QuoteArg(launcherScript) & fullArgStr
On Error Resume Next
exitCode = shell.Run(cmdLine, 0, True)
errNum = Err.Number
errDesc = Err.Description
Err.Clear
On Error GoTo 0

If errNum <> 0 Or exitCode <> 0 Then
  Dim detailText
  detailText = ChrW(26080) & ChrW(27861) & ChrW(21551) & ChrW(21160) & " AI Canvas Studio " & ChrW(30011) & ChrW(24067) & ChrW(24037) & ChrW(20316) & ChrW(21488) & ChrW(12290) & vbCr & vbLf & vbCr & vbLf & ChrW(35831) & ChrW(26816) & ChrW(26597) & ChrW(26500) & ChrW(24314) & ChrW(20135) & ChrW(29289) & ChrW(25110) & ChrW(26597) & ChrW(30475) & ChrW(21551) & ChrW(21160) & ChrW(26085) & ChrW(24535) & ChrW(65306) & vbCr & vbLf & logPath
  If errNum <> 0 Then
    detailText = detailText & vbCr & vbLf & vbCr & vbLf & ChrW(38169) & ChrW(35823) & ChrW(35814) & ChrW(24773) & ChrW(65306) & errDesc & " (" & CStr(errNum) & ")"
  Else
    detailText = detailText & vbCr & vbLf & vbCr & vbLf & ChrW(38169) & ChrW(35823) & ChrW(35814) & ChrW(24773) & ChrW(65306) & "exit code " & CStr(exitCode)
  End If
  MsgBox detailText, vbCritical, ChrW(30011) & ChrW(24067) & ChrW(24037) & ChrW(20316) & ChrW(21488) & ChrW(21551) & ChrW(21160) & ChrW(22833) & ChrW(36133)
  WScript.Quit 1
End If
