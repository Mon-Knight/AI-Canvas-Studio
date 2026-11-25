; Inno Setup script for AI Canvas Studio (zero-admin user install)

#ifndef MyAppVersion
  #define MyAppVersion "1.1.4"
#endif

#define MyAppName "AI Canvas Studio"
#define MyAppPublisher "Mon-Knight"
#define MyAppURL "https://github.com/Mon-Knight/AI-Canvas-Studio"
#define MyAppExeName "AI-Canvas-Studio.exe"

[Setup]
AppId={{8C9B7C6A-1F22-4B7A-9B3E-9A5E140B7741}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\AI-Canvas-Studio
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\release
OutputBaseFilename=AI-Canvas-Studio-v{#MyAppVersion}-win64-setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\desktop\assets\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Remove stale hashed frontend bundles and prior runtime binaries on in-place upgrades
; while keeping any user data under {app}\data or %APPDATA% untouched.
Type: filesandordirs; Name: "{app}\resources\frontend-dist"
Type: filesandordirs; Name: "{app}\resources\app"
Type: filesandordirs; Name: "{app}\resources\extension"
Type: filesandordirs; Name: "{app}\resources\agent-bin"

[Files]
Source: "..\release\AI-Canvas-Studio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\resources\icon.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\resources\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  // Terminate any still-running Electron shell or windowless FastAPI agent so
  // locked binaries are cleanly overwritten and post-install launch starts the
  // newly installed version instead of focusing an older single-instance window.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AI-Canvas-Studio.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM flowboard-agent.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(500);
  Result := '';
end;
