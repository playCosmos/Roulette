param(
    [string]$Version = "0.4.0",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$BridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $BridgeRoot
$DistRoot = Join-Path $BridgeRoot "dist-games"
$InputRoot = Join-Path $BridgeRoot "package-input-games"
$JarName = "ramyani-game-server-0.2.0-SNAPSHOT.jar"
$JarPath = Join-Path $BridgeRoot "target\$JarName"
$AppRoot = Join-Path $DistRoot "RamyaniGamesServer"

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
    --name RamyaniGamesServer `
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

$Exe = Join-Path $AppRoot "RamyaniGamesServer.exe"
if (-not (Test-Path $Exe)) {
    throw "Packaged games server executable was not created"
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
RamyaniGamesServer Windows x64
===============================

방송에서 사용할 게임을 서버가 제공하고, 방송 참가자는 브라우저 오버레이 URL만 사용하는 서버/클라이언트 구조입니다.
현재 멀티플레이 모듈은 보드게임입니다.

서버
----
1. RamyaniGamesServer.exe를 실행합니다.
2. 관리자 UI: http://127.0.0.1:17830/board-admin.html
3. 관리자 API는 기본적으로 127.0.0.1:17830에만 바인딩됩니다.
4. 보드게임 DB: data/board-game.db

클라이언트
----------
1. 읽기 전용 게임 클라이언트 HTTP: 0.0.0.0:17832
2. 실시간 WebSocket: 0.0.0.0:17831
3. 참가자는 프로그램을 설치하지 않고, 룸 운영 페이지에서 받은 동일한 오버레이 URL을 각자 OBS 브라우저 소스에 사용합니다.
4. 클라이언트 HTTP에서는 룸 생성/종료/수동 턴 같은 관리 POST API를 사용할 수 없습니다.

외부 공유
---------
인터넷을 통해 참가자에게 링크를 보낼 경우 config.json의 아래 두 값을 실제 공개 주소로 설정하십시오.

server.publicBaseUrl
  예: https://games.example.com

server.publicWebSocketUrl
  예: wss://games.example.com/ws

리버스 프록시를 사용하는 경우 publicBaseUrl은 client HTTP(내부 17832)로,
publicWebSocketUrl은 WebSocket(내부 17831)으로 전달하십시오.

관리 포트 17830은 외부 공개하지 않는 것을 전제로 합니다.
"@
Set-Content -Path (Join-Path $AppRoot "README.txt") -Value $Readme -Encoding UTF8

Remove-Item $InputRoot -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[games-package] created: $AppRoot"
Write-Host "[games-package] executable: $Exe"
