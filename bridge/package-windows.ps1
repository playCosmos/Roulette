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
    --win-console

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
    "soop-overlay-archive.js"
) | ForEach-Object {
    Copy-Item (Join-Path $RepoRoot $_) (Join-Path $WebRoot $_) -Force
}
Copy-Item (Join-Path $RepoRoot "assets") (Join-Path $WebRoot "assets") -Recurse -Force

# These folders are runtime-owned. Existing contents must never be overwritten by an update package.
@("data", "tickets", "backups", "logs") | ForEach-Object {
    New-Item -ItemType Directory -Path (Join-Path $AppRoot $_) -Force | Out-Null
}

$Readme = @"
RouletteBridge Windows x64
=========================

1. Edit config.json and set streamerId.
2. Run RouletteBridge.exe.
3. OBS Browser Source:
   http://127.0.0.1:17820/soop-overlay.html?ws=ws://127.0.0.1:17821
4. Runtime data is stored in data/, tickets/, backups/, and logs/.
5. Do not delete those folders when updating the program.

This distribution contains its own Java runtime. A separate Java installation is not required.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[package] created: $AppRoot"
Write-Host "[package] executable: $(Join-Path $AppRoot 'RouletteBridge.exe')"
Write-Host "[package] config: $(Join-Path $AppRoot 'config.json')"
