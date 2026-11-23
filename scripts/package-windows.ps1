<#
.SYNOPSIS
    Build standalone Windows distribution for AI Canvas Studio:
    - Portable zero-install archive: release/AI-Canvas-Studio-v<Version>-win64-portable.zip
    - Standard Windows installer (if Inno Setup ISCC.exe is installed): release/AI-Canvas-Studio-v<Version>-win64-setup.exe
#>
[CmdletBinding()]
param(
    [string]$Version = "0.9.0",
    [string]$PythonExe = "",
    [switch]$SkipNpmCi
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-LastExit([string]$StepName) {
    if ($LASTEXITCODE -ne 0) {
        throw "Step '$StepName' failed with exit code $LASTEXITCODE"
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$FrontendDir = Join-Path $RepoRoot "frontend"
$DesktopDir = Join-Path $RepoRoot "desktop"
$AgentDir = Join-Path $RepoRoot "agent"
$ExtensionDir = Join-Path $RepoRoot "extension"
$StagingDir = Join-Path $RepoRoot "build-staging"
$ReleaseDir = Join-Path $RepoRoot "release"
$AppOutDir = Join-Path $ReleaseDir "AI-Canvas-Studio"

if (-not $PythonExe) {
    $venvPy = Join-Path $AgentDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPy) {
        $PythonExe = $venvPy
    } else {
        $PythonExe = (Get-Command python).Source
    }
}
if (-not (Test-Path $PythonExe)) {
    throw "Python executable not found: $PythonExe"
}

Write-Host "==> [1/6] Building Frontend..."
Push-Location $FrontendDir
try {
    if (-not $SkipNpmCi) {
        npm ci
        Assert-LastExit "frontend npm ci"
    }
    npx vite build
    Assert-LastExit "frontend vite build"
} finally {
    Pop-Location
}

Write-Host "==> [2/6] Building Desktop (Electron main + preload)..."
Push-Location $DesktopDir
try {
    if (-not $SkipNpmCi) {
        npm ci
        Assert-LastExit "desktop npm ci"
    }
    npm run build
    Assert-LastExit "desktop build"
} finally {
    Pop-Location
}

Write-Host "==> [3/6] Freezing FastAPI backend via PyInstaller ($PythonExe)..."
if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

$PyDistDir = Join-Path $StagingDir "pyinstaller-dist"
$PyWorkDir = Join-Path $StagingDir "pyinstaller-work"

Push-Location $AgentDir
try {
    & $PythonExe -m PyInstaller `
        --noconfirm `
        --clean `
        --onedir `
        --noconsole `
        --name "flowboard-agent" `
        --distpath $PyDistDir `
        --workpath $PyWorkDir `
        --specpath $StagingDir `
        --paths $AgentDir `
        --collect-submodules flowboard `
        --collect-submodules uvicorn `
        --collect-submodules sqlmodel `
        --collect-submodules websockets `
        --collect-submodules fastapi `
        --collect-submodules starlette `
        --collect-submodules httpx `
        --collect-submodules pydantic `
        --collect-submodules sqlalchemy `
        --collect-submodules python_multipart `
        --collect-submodules multipart `
        --collect-submodules anyio `
        --collect-submodules httpcore `
        --collect-data certifi `
        --copy-metadata python-multipart `
        --copy-metadata fastapi `
        --copy-metadata pydantic `
        (Join-Path $AgentDir "run_agent.py")
    Assert-LastExit "PyInstaller flowboard-agent"
} finally {
    Pop-Location
}

$PackagedAgentDir = Join-Path $PyDistDir "flowboard-agent"
$PackagedAgentExe = Join-Path $PackagedAgentDir "flowboard-agent.exe"
if (-not (Test-Path $PackagedAgentExe)) {
    throw "PyInstaller output missing: $PackagedAgentExe"
}

Write-Host "==> Smoke testing flowboard-agent.exe --pick-images --self-test..."
$pickerSelfTest = & $PackagedAgentExe --pick-images --self-test
Assert-LastExit "flowboard-agent.exe --pick-images --self-test"
Write-Host "Picker self-test output: $pickerSelfTest"

Write-Host "==> Smoke testing flowboard-agent.exe --self-test-server..."
$serverSelfTest = & $PackagedAgentExe --self-test-server
Assert-LastExit "flowboard-agent.exe --self-test-server"
Write-Host "Server self-test output: $serverSelfTest"

Write-Host "==> [4/6] Assembling standalone AI-Canvas-Studio runtime..."
if (Test-Path $ReleaseDir) { Remove-Item $ReleaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $AppOutDir -Force | Out-Null

$ElectronDist = Join-Path $DesktopDir "node_modules\electron\dist"
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) {
    throw "Electron dist missing: $ElectronDist"
}
Copy-Item -Path (Join-Path $ElectronDist "*") -Destination $AppOutDir -Recurse -Force
Rename-Item -Path (Join-Path $AppOutDir "electron.exe") -NewName "AI-Canvas-Studio.exe"

$IconIco = Join-Path $RepoRoot "desktop\assets\icon.ico"
$IconPng = Join-Path $RepoRoot "desktop\assets\icon.png"
if (Test-Path $IconIco) {
    Write-Host "==> Embedding custom icon into AI-Canvas-Studio.exe..."
    $peVer = if ($Version -match '^\d+\.\d+$') { "$Version.0" } else { $Version }
    $targetExe = Join-Path $AppOutDir "AI-Canvas-Studio.exe"
    Push-Location $DesktopDir
    try {
        node --input-type=module -e "import { rcedit } from 'rcedit'; await rcedit(process.argv[1], { icon: process.argv[2], 'file-version': process.argv[3], 'product-version': process.argv[3], 'version-string': { ProductName: 'AI Canvas Studio', FileDescription: 'AI Canvas Studio', CompanyName: 'Mon-Knight' } });" $targetExe $IconIco $peVer
        Assert-LastExit "rcedit icon embedding"
    } finally {
        Pop-Location
    }
}

$ResourcesDir = Join-Path $AppOutDir "resources"
if (Test-Path $IconIco) { Copy-Item -Path $IconIco -Destination (Join-Path $ResourcesDir "icon.ico") -Force }
if (Test-Path $IconPng) { Copy-Item -Path $IconPng -Destination (Join-Path $ResourcesDir "icon.png") -Force }
$DefaultAsar = Join-Path $ResourcesDir "default_app.asar"
if (Test-Path $DefaultAsar) { Remove-Item $DefaultAsar -Force }

$AppDir = Join-Path $ResourcesDir "app"
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

$AppPkg = @{
    name        = "ai-canvas-studio"
    version     = $Version
    private     = $true
    description = "AI Canvas Studio Standalone Runtime"
    main        = "dist/main.js"
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $AppDir "package.json"), $AppPkg, [System.Text.UTF8Encoding]::new($false))

Copy-Item -Path (Join-Path $DesktopDir "dist") -Destination (Join-Path $AppDir "dist") -Recurse -Force
$WsSource = Join-Path $DesktopDir "node_modules\ws"
if (Test-Path $WsSource) {
    $AppNodeModules = Join-Path $AppDir "node_modules"
    New-Item -ItemType Directory -Path $AppNodeModules -Force | Out-Null
    Copy-Item -Path $WsSource -Destination (Join-Path $AppNodeModules "ws") -Recurse -Force
}

Copy-Item -Path (Join-Path $FrontendDir "dist") -Destination (Join-Path $ResourcesDir "frontend-dist") -Recurse -Force
Copy-Item -Path $ExtensionDir -Destination (Join-Path $ResourcesDir "extension") -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $ResourcesDir "agent-bin") -Force | Out-Null
Copy-Item -Path (Join-Path $PackagedAgentDir "*") -Destination (Join-Path $ResourcesDir "agent-bin") -Recurse -Force

$UsageNote = @"
AI Canvas Studio v$Version — 使用说明
====================================

1. 双击本目录下的 AI-Canvas-Studio.exe 即可直接启动工作台（无需安装 Python、Node.js 或手动加载浏览器扩展）。
2. 首次启动后，点击右上角账号区域登录并绑定你自己的 Google Flow 项目，即可开始图片、视频、分镜故事板与角色一致性创作。
3. 便携绿色版说明：本程序的所有画布数据、媒体缓存与登录配置默认保存在同目录的 data\ 文件夹中，可整体拷贝迁移。
4. 如需使用文字扩写 / AI 润色 / 图像反推，可在右上角设置面板填入任意 OpenAI 兼容或 Gemini 接口与密钥。
"@
[System.IO.File]::WriteAllText((Join-Path $AppOutDir "使用说明.txt"), $UsageNote, [System.Text.UTF8Encoding]::new($true))

Write-Host "==> [5/6] Creating Portable ZIP..."
$PortableMarker = Join-Path $ResourcesDir ".portable"
New-Item -ItemType File -Path $PortableMarker -Force | Out-Null
$PortableZip = Join-Path $ReleaseDir "AI-Canvas-Studio-v$Version-win64-portable.zip"
Compress-Archive -Path $AppOutDir -DestinationPath $PortableZip -CompressionLevel Optimal -Force

Write-Host "==> [6/6] Building Windows Installer (Inno Setup)..."
Remove-Item $PortableMarker -Force
$IsccCandidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$IsccCmd = Get-Command iscc -ErrorAction SilentlyContinue
if ($IsccCmd) { $IsccCandidates = @($IsccCmd.Source) + $IsccCandidates }
$IsccExe = $IsccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($IsccExe) {
    & $IsccExe "/DMyAppVersion=$Version" (Join-Path $PSScriptRoot "installer.iss")
    Assert-LastExit "Inno Setup ISCC.exe"
} else {
    Write-Warning "ISCC.exe (Inno Setup 6) not found — skipped Setup.exe creation (Portable ZIP is ready)."
}

$HashLines = @()
Get-ChildItem -Path $ReleaseDir -File | Where-Object { $_.Name -like "AI-Canvas-Studio-v*" } | Sort-Object Name | ForEach-Object {
    $h = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $HashLines += "$h  $($_.Name)"
}
if ($HashLines.Count -gt 0) {
    [System.IO.File]::WriteAllLines((Join-Path $ReleaseDir "SHA256SUMS.txt"), $HashLines, [System.Text.UTF8Encoding]::new($false))
}

Write-Host "==> Packaging complete. Output files in ${ReleaseDir}:"
Get-ChildItem -Path $ReleaseDir -File | ForEach-Object {
    Write-Host ("  - {0} ({1:N2} MB)" -f $_.Name, ($_.Length / 1MB))
}
