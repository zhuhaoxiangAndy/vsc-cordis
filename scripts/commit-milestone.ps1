# Commit one milestone on its own branch, merge back into main, then push.
#
# Usage:
#   .\scripts\commit-milestone.ps1 -Branch feat/xxx -MessageFile scripts\commit-messages\NN-name.txt
#                                  [-MergeMessage "chore: merge ..."] [-NoPush]
#
# ASCII-only on purpose (see bootstrap-git.ps1 for the PowerShell 5.1 ANSI note):
# non-ASCII text in a BOM-less .ps1 is decoded with the ANSI code page, which can
# swallow adjacent quote bytes and break parsing. Chinese commit messages live in
# scripts/commit-messages/*.txt and are passed via `git commit -F`.
#
# Guard rails:
#   - refuses to run if the branch already exists (never rewrites history);
#   - never force-pushes.

param(
    [Parameter(Mandatory = $true)][string] $Branch,
    [Parameter(Mandatory = $true)][string] $MessageFile,
    [string] $MergeMessage = '',
    [switch] $NoPush
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ([string]::IsNullOrWhiteSpace($MergeMessage)) {
    $MergeMessage = "chore: merge $Branch"
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]] $GitArgs)
    & git @GitArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) {
        throw ("git {0} failed with exit code {1}" -f ($GitArgs -join ' '), $LASTEXITCODE)
    }
}

$existing = (& git branch --list $Branch 2>&1 | Out-String).Trim()
if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Write-Host "[skip] branch $Branch already exists; refusing to rewrite history."
    exit 0
}

$messagePath = Join-Path $root $MessageFile
if (-not (Test-Path $messagePath)) {
    throw "commit message file not found: $MessageFile"
}

Invoke-Git switch main
Invoke-Git switch -c $Branch

Write-Host '[step] stage all changes (node_modules/ and dist/ are gitignored)'
Invoke-Git add -A
Invoke-Git status --short

Write-Host '[step] commit milestone'
Invoke-Git commit -F $messagePath

Write-Host '[step] merge back into main (--no-ff)'
Invoke-Git switch main
Invoke-Git merge --no-ff $Branch -m $MergeMessage

if ($NoPush) {
    Write-Host '[skip] push disabled (--NoPush)'
} else {
    Write-Host '[step] push'
    Invoke-Git push origin main
    Invoke-Git push origin $Branch
}

Write-Host ''
Write-Host '=== git log ==='
Invoke-Git --no-pager log --oneline --graph --decorate -6
