# One-shot: commit the host-extension milestone on its own branch, merge into main, push.
#
# Keeps this file ASCII-only (see bootstrap-git.ps1 for why: PowerShell 5.1 decodes
# BOM-less .ps1 using the ANSI code page and Chinese text would corrupt the script).
# The Chinese commit message lives in scripts/commit-messages/04-host.txt.
#
# Note: git writes progress/informational text to stderr, and PowerShell 5.1 turns that into
# a NativeCommandError. With $ErrorActionPreference='Stop' that aborts the script even when git
# exited 0. So we keep it 'Continue' and check $LASTEXITCODE explicitly instead.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$branch = 'feat/host-extension-m1m2'
$messageFile = Join-Path $PSScriptRoot 'commit-messages\04-host.txt'

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $GitArgs)
    & git @GitArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        throw ("git {0} failed with exit code {1}" -f ($GitArgs -join ' '), $LASTEXITCODE)
    }
}

$existing = (& git branch --list $branch 2>&1 | Out-String).Trim()
if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Write-Host "[skip] branch $branch already exists; refusing to rewrite history."
    exit 0
}

Invoke-Git switch main
Invoke-Git switch -c $branch

Write-Host '[step] stage all changes (node_modules/ and dist/ are gitignored)'
Invoke-Git add -A
Invoke-Git status --short

Write-Host '[step] commit milestone'
Invoke-Git commit -F $messageFile

Write-Host '[step] merge back into main (--no-ff)'
Invoke-Git switch main
Invoke-Git merge --no-ff $branch -m 'chore: merge host extension milestone (M1+M2)'

Write-Host '[step] push'
Invoke-Git push origin main
Invoke-Git push origin $branch

Write-Host ''
Write-Host '=== git log ==='
Invoke-Git --no-pager log --oneline --graph --decorate -6
