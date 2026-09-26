param(
    [string]$Version = "0.3.0",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$BridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $BridgeRoot
$DistRoot = Join-Path $BridgeRoot "dist-board"
$InputRoot = Join-Path $BridgeRoot "package-input-board"
$JarName = "ramyani-game-server-0.2.0-SNAPSHOT.jar"
$JarPath = Join-Path $BridgeRoot "target\$JarName"
$AppRoot = Join-Path $DistRoot "RamyaniBoardGameServer"

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
    throw "Server jar not found: $JarPath"
}

Remove-Item $DistRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $DistRoot | Out-Null
New-Item -ItemType Directory -Path $InputRoot | Out-Null
Copy-Item $JarPath (Join-Path $InputRoot $JarName)

$jpackage = Get-Command jpackage -ErrorAction Stop
& $jpackage.Source `
    --type app-image `
    --name RamyaniBoardGameServer `
    --app-version $Version `
    --dest $DistRoot `
    --input $InputRoot `
    --main-jar $JarName `
    --main-class io.github.playcosmos.roulettebridge.boardserver.BoardGameServerMain `
    --java-options "--enable-native-access=ALL-UNNAMED" `
    --java-options "-Dfile.encoding=UTF-8" `
    --java-options "-Dstdout.encoding=UTF-8" `
    --java-options "-Dstderr.encoding=UTF-8"

if ($LASTEXITCODE -ne 0) {
    throw "jpackage failed with exit code $LASTEXITCODE"
}

$Exe = Join-Path $AppRoot "RamyaniBoardGameServer.exe"
if (-not (Test-Path $Exe)) {
    throw "Packaged board-game executable was not created"
}

Copy-Item (Join-Path $BridgeRoot "board-config.example.json") (Join-Path $AppRoot "config.json") -Force

$WebRoot = Join-Path $AppRoot "web"
New-Item -ItemType Directory -Path $WebRoot -Force | Out-Null
Copy-Item (Join-Path $RepoRoot "board-admin.html") (Join-Path $WebRoot "board-admin.html") -Force
Copy-Item (Join-Path $RepoRoot "board-room.html") (Join-Path $WebRoot "board-room.html") -Force

$AdminRoot = Join-Path $WebRoot "soop\admin"
New-Item -ItemType Directory -Path $AdminRoot -Force | Out-Null
@(
    "soop-admin.css",
    "board-room-admin.css",
    "board-room-admin.js",
    "board-room-operation.css",
    "board-room-operation.js"
) | ForEach-Object {
    Copy-Item (Join-Path $RepoRoot ("soop\admin\" + $_)) (Join-Path $AdminRoot $_) -Force
}

$GamesRoot = Join-Path $WebRoot "games"
New-Item -ItemType Directory -Path $GamesRoot -Force | Out-Null
Copy-Item (Join-Path $RepoRoot "games\board") (Join-Path $GamesRoot "board") -Recurse -Force

New-Item -ItemType Directory -Path (Join-Path $AppRoot "data") -Force | Out-Null

$Readme = @"
RamyaniBoardGameServer Windows x64
==================================

보드게임 전용 서버입니다. 룰렛 티켓 발급, 티켓 PNG, 룰렛 OBS 오버레이 기능은 포함하지 않습니다.

1. RamyaniBoardGameServer.exe를 실행합니다.
2. config.json의 streamerId에 SOOP 방송 채널 ID를 입력합니다.
3. 기본 관리자 주소: http://127.0.0.1:17830/board-admin.html
4. 기본 WebSocket 주소: ws://127.0.0.1:17831
5. 보드게임 DB: data/board-game.db
6. 룸 확정 후 board-room.html 운영 페이지로 이동합니다.
7. 운영 페이지에서 플레이어별 수동 턴/위치 보정, 일시정지/재개, 시간 연장, 룸 종료가 가능합니다.
8. PAUSED 상태에서도 운영자 수동 턴/위치 보정은 사용할 수 있습니다.
9. Java runtime은 배포본에 포함됩니다.

기본 포트는 통합 서버와 충돌하지 않도록 17830/17831을 사용합니다.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[board-package] created: $AppRoot"
Write-Host "[board-package] executable: $Exe"
