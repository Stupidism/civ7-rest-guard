param([string]$ModsPath = (Join-Path $env:LOCALAPPDATA "Firaxis Games\Sid Meier's Civilization VII\Mods"))
$ErrorActionPreference = 'Stop'
if (Get-Process -Name 'Civ7_Win64_DX12_FinalRelease','Civ7_Win64_Vulkan_FinalRelease' -ErrorAction SilentlyContinue) {
    throw 'Please close Civilization VII before installing Rest Guard.'
}
$sourceRoot = $PSScriptRoot
$targetRoot = [IO.Path]::GetFullPath((Join-Path $ModsPath 'civ7-rest-guard'))
if ($targetRoot -eq [IO.Path]::GetFullPath($sourceRoot)) { throw 'Source and destination must differ.' }
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'rest-guard.modinfo'))) { throw 'Mod manifest missing.' }
if (Test-Path -LiteralPath $targetRoot) {
    $backupRoot = Join-Path (Split-Path $ModsPath -Parent) ('ModUserData\RestGuardBackups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Copy-Item -LiteralPath $targetRoot -Destination $backupRoot -Recurse
    Write-Output "Previous version backed up: $backupRoot"
}
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'rest-guard.modinfo') -Destination $targetRoot -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'ui') -Destination $targetRoot -Recurse -Force
$readme = Join-Path $sourceRoot 'README-zh-CN.txt'
if (Test-Path -LiteralPath $readme) { Copy-Item -LiteralPath $readme -Destination $targetRoot -Force }
$sourceFiles = Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'ui') -File
foreach ($file in $sourceFiles) {
    $copy = Join-Path $targetRoot ('ui\' + $file.Name)
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $copy).Hash) {
        throw "Verification failed: $copy"
    }
}
Write-Output "Installed and verified: $targetRoot"
Write-Output 'Enable Rest Guard in the game Add-ons / Mods menu, then load a single-player game.'
