param(
    [string]$Version = "0.1.0",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$BridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $BridgeRoot
$DistRoot = Join-Path $BridgeRoot "dist"
$InputRoot = Join-Path $BridgeRoot "package-input"
$JarName = "roulette-bridge-0.1.0-SNAPSHOT.jar"
$JarPath = Join-Path $BridgeRoot "target\$JarName"
$AppRoot = Join-Path $DistRoot "RouletteBridge"

if (-not $SkipBuild) {
    Push-Location $BridgeRoot
    try {
        mvn --batch-mode --no-transfer-progress clean package
        if ($LASTEXITCODE -ne 0) { throw "Maven build failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $JarPath)) {
    throw "Bridge jar not found: $JarPath"
}

Remove-Item $DistRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $DistRoot | Out-Null
New-Item -ItemType Directory -Path $InputRoot | Out-Null
Copy-Item $JarPath (Join-Path $InputRoot $JarName)

$jpackage = Get-Command jpackage -ErrorAction Stop
& $jpackage.Source `
    --type app-image `
    --name RouletteBridge `
    --app-version $Version `
    --dest $DistRoot `
    --input $InputRoot `
    --main-jar $JarName `
    --main-class io.github.playcosmos.roulettebridge.Main `
    --java-options "--enable-native-access=ALL-UNNAMED" `
    --java-options "-Dfile.encoding=UTF-8" `
    --java-options "-Dstdout.encoding=UTF-8" `
    --java-options "-Dstderr.encoding=UTF-8"

if ($LASTEXITCODE -ne 0) {
    throw "jpackage failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path (Join-Path $AppRoot "RouletteBridge.exe"))) {
    throw "Packaged executable was not created"
}

# User-editable config lives beside RouletteBridge.exe.
Copy-Item (Join-Path $BridgeRoot "config.example.json") (Join-Path $AppRoot "config.json") -Force

# The packaged app serves the OBS overlay locally. Keep the original GitHub page independent.
$WebRoot = Join-Path $AppRoot "web"
New-Item -ItemType Directory -Path $WebRoot | Out-Null
@(
    "soop-overlay.html",
    "soop-overlay.css",
    "soop-overlay.js",
    "soop-overlay-archive.js",
    "soop-admin.html",
    "soop-admin.css",
    "soop-admin.js"
) | ForEach-Object {
    $source = Join-Path $RepoRoot $_
    if (-not (Test-Path $source)) { throw "Required web asset missing: $source" }
    Copy-Item $source (Join-Path $WebRoot $_) -Force
}
Copy-Item (Join-Path $RepoRoot "assets") (Join-Path $WebRoot "assets") -Recurse -Force

# Runtime-owned visible data folders. The log folder is created hidden by the app on Windows.
@("data", "tickets", "backups") | ForEach-Object {
    New-Item -ItemType Directory -Path (Join-Path $AppRoot $_) -Force | Out-Null
}

$Readme = @"
RouletteBridge Windows x64
=========================

1. Edit config.json and set streamerId.
2. Run RouletteBridge.exe. The bridge runs from the Windows notification area (system tray).
3. Double-click the tray icon, or use "관리자 페이지 열기", to open the local admin page.
4. OBS Browser Source:
   http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
5. Runtime data is stored in data/, tickets/, and backups/. Internal logs are kept separately by the app.
6. Do not delete the runtime data folders or your existing config.json when updating.

This distribution contains its own Java runtime. A separate Java installation is not required.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[package] created: $AppRoot"
Write-Host "[package] executable: $(Join-Path $AppRoot 'RouletteBridge.exe')"
Write-Host "[package] config: $(Join-Path $AppRoot 'config.json')"
