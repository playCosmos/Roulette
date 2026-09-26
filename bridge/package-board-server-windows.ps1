param(
    [string]$Version = "0.4.1",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $ScriptRoot "package-games-server-windows.ps1"

Write-Warning "package-board-server-windows.ps1 is retained for compatibility. Packaging RamyaniGamesServer instead."

if ($SkipBuild) {
    & $Target -Version $Version -SkipBuild
}
else {
    & $Target -Version $Version
}

exit $LASTEXITCODE
