param(
    [Parameter(Mandatory = $true)]
    [long]$ParentPid,

    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = "SilentlyContinue"

for ($i = 0; $i -lt 160; $i++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 250
}

$exePath = [System.IO.Path]::GetFullPath($Executable)
$workDir = Split-Path -Parent $exePath
Start-Process -FilePath $exePath -WorkingDirectory $workDir | Out-Null
