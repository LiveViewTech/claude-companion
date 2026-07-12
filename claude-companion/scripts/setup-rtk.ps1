#!/usr/bin/env pwsh
<#
.SYNOPSIS
    One-shot installer for rtk (Rust Token Killer) + the Claude Code hook, on Windows.

.DESCRIPTION
    rtk (https://github.com/rtk-ai/rtk) is a Rust CLI proxy that filters/compresses
    dev-command output to cut LLM token use by 60-90%. On Windows there is no official
    install script, so this does the whole dance:

      1. Resolve the target release (latest, or a pinned -Version).
      2. Download the Windows binary + checksums.txt from GitHub.
      3. Verify the SHA256 before trusting the zip.
      4. Extract rtk.exe into a PATH directory (default: ~\.local\bin).
      5. Ensure the dir is on your *user* PATH.
      6. Ensure ripgrep (rg) is installed - some rtk filters shell out to it.
      7. Register the Claude Code PreToolUse hook via `rtk init -g --auto-patch`,
         which MERGES into settings.json (existing hooks + permission rules preserved).
         settings.json is backed up first, just in case.

    Re-runnable: if rtk is already at the target version and the hook is configured,
    those steps are skipped. Use -Force to redo them.

.PARAMETER Version
    Release tag to install (e.g. 'v0.43.0'), or 'latest' (default).

.PARAMETER InstallDir
    Where rtk.exe lands. Default: "$env:USERPROFILE\.local\bin".

.PARAMETER SkipRipgrep
    Don't check for / install ripgrep.

.PARAMETER SkipInit
    Install the binary only; don't touch settings.json / register the hook.

.PARAMETER Force
    Re-download and re-run `rtk init` even if things look already set up.

.EXAMPLE
    pwsh -File setup-rtk.ps1
    pwsh -File setup-rtk.ps1 -Version v0.43.0
    pwsh -File setup-rtk.ps1 -SkipInit          # just get the binary on PATH

.NOTES
    Tested on Windows 11. Undo the hook with:  rtk init -g --uninstall
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$InstallDir = "$env:USERPROFILE\.local\bin",
    [switch]$SkipRipgrep,
    [switch]$SkipInit,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Repo   = 'rtk-ai/rtk'
$Asset  = 'rtk-x86_64-pc-windows-msvc.zip'   # rtk ships only x86_64 for Windows
$Header = @{ 'User-Agent' = 'rtk-setup' }

function Info($m) { Write-Host "[rtk-setup] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[rtk-setup] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[rtk-setup] $m" -ForegroundColor Yellow }

function Get-TargetTag {
    if ($Version -ne 'latest') { return $Version }
    Info 'Resolving latest release...'
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Header -TimeoutSec 30
    return $rel.tag_name
}

function Get-InstalledVersion($exe) {
    if (-not (Test-Path $exe)) { return $null }
    try { (& $exe --version) -replace '^rtk\s+', '' } catch { return $null }
}

# Refresh PATH from the registry so tools a previous run persisted (rtk, rg) are
# visible in this fresh process without needing a brand-new terminal.
$env:Path = ($env:Path,
             [Environment]::GetEnvironmentVariable('Path', 'Machine'),
             [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'

# --- ARM64 note: no native Windows-arm64 asset exists; x64 runs under emulation ----
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    Warn 'ARM64 detected. rtk ships only an x86_64 Windows binary; it will run under emulation.'
}

$tag        = Get-TargetTag
$wantVer    = $tag -replace '^v', ''
$rtkExe     = Join-Path $InstallDir 'rtk.exe'
$installed  = Get-InstalledVersion (Get-Command rtk -ErrorAction SilentlyContinue).Source

# ----------------------------------------------------------------------------------
# 1-4. Download + verify + extract (unless already current)
# ----------------------------------------------------------------------------------
if (-not $Force -and $installed -eq $wantVer) {
    Ok "rtk $installed already installed; skipping download (use -Force to reinstall)."
}
else {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rtk-setup-" + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        $zip     = Join-Path $tmp $Asset
        $sumFile = Join-Path $tmp 'checksums.txt'
        $base    = "https://github.com/$Repo/releases/download/$tag"

        Info "Downloading $Asset ($tag)..."
        Invoke-WebRequest -Uri "$base/$Asset"         -OutFile $zip     -Headers $Header -TimeoutSec 120
        Invoke-WebRequest -Uri "$base/checksums.txt"  -OutFile $sumFile -Headers $Header -TimeoutSec 120

        Info 'Verifying SHA256...'
        $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        $line   = Get-Content $sumFile | Where-Object { $_ -match [regex]::Escape($Asset) } | Select-Object -First 1
        if (-not $line) { throw "checksums.txt has no entry for $Asset" }
        $expected = (($line -split '\s+') | Where-Object { $_ })[0].ToLower()
        if ($actual -ne $expected) {
            throw "Checksum mismatch!`n  expected $expected`n  actual   $actual"
        }
        Ok "Checksum verified ($expected)."

        Info "Extracting rtk.exe -> $InstallDir"
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $found = Get-ChildItem -Path $tmp -Recurse -Filter 'rtk.exe' | Select-Object -First 1
        if (-not $found) { throw 'rtk.exe not found inside the archive' }
        Copy-Item -Path $found.FullName -Destination $rtkExe -Force
        Ok "Installed rtk $wantVer -> $rtkExe"
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# ----------------------------------------------------------------------------------
# 5. Ensure InstallDir is on the user PATH
# ----------------------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $InstallDir) {
    Info "Adding $InstallDir to your user PATH..."
    $newPath = ($userPath.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Warn 'PATH updated - open a NEW terminal for it to take effect elsewhere.'
}
else {
    Ok "$InstallDir already on user PATH."
}
# make rtk callable in THIS session regardless
if (($env:Path -split ';') -notcontains $InstallDir) { $env:Path += ";$InstallDir" }

# ----------------------------------------------------------------------------------
# 6. Ensure ripgrep (rg) - some rtk filters shell out to it
# ----------------------------------------------------------------------------------
if (-not $SkipRipgrep) {
    if (Get-Command rg -ErrorAction SilentlyContinue) {
        Ok 'ripgrep (rg) already available.'
    }
    elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Info 'Installing ripgrep via winget...'
        winget install --id BurntSushi.ripgrep.MSVC -e --accept-source-agreements --accept-package-agreements --disable-interactivity
        Warn 'ripgrep installed - open a NEW terminal so rtk can find rg on PATH.'
    }
    else {
        Warn 'ripgrep (rg) not found and winget unavailable. Install it and keep rg.exe on PATH;'
        Warn 'without it, rtk''s content/search filters degrade (rtk still works otherwise).'
    }
}

# ----------------------------------------------------------------------------------
# 7. Register the Claude Code hook (settings.json MERGE, backed up first)
# ----------------------------------------------------------------------------------
if (-not $SkipInit) {
    $show = (& $rtkExe init -g --show 2>&1 | Out-String)
    if (($show -match 'RTK hook configured') -and -not $Force) {
        Ok 'Claude Code hook already configured; skipping init (use -Force to re-run).'
    }
    else {
        $settings = Join-Path $env:USERPROFILE '.claude\settings.json'
        if (Test-Path $settings) {
            $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backup = "$settings.rtk-setup-backup-$stamp"
            Copy-Item $settings $backup -Force
            Ok "Backed up settings.json -> $backup"
        }
        Info 'Registering hook: rtk init -g --auto-patch'
        & $rtkExe init -g --auto-patch
    }
}

# ----------------------------------------------------------------------------------
# Verify + summary
# ----------------------------------------------------------------------------------
Write-Host ''
Info '--- verification ---'
& $rtkExe --version
if (-not $SkipInit) { & $rtkExe init -g --show 2>&1 | Select-String -Pattern 'Hook:|RTK.md:|settings.json:' }
Write-Host ''
Ok 'Done. Restart Claude Code so the hook loads (hooks snapshot at session start).'
Ok 'Test after restart:  run `git status` and confirm rtk savings via `rtk gain`.'
