# One-shot bootstrap: initialise the repository and split commits by milestone.
# User decision: one branch per milestone + Conventional Commits, merged back into main.
#
# Commit messages live in scripts/commit-messages/*.txt (UTF-8) and are passed via
# `git commit -F` / `git merge -F`, which sidesteps Windows console encoding problems
# with inline -m.
#
# IMPORTANT: keep this file ASCII-only. PowerShell decodes .ps1 files that have no BOM
# using the ANSI code page, which corrupts non-ASCII text and can even swallow the
# quote bytes that follow it, breaking the whole script.
#
# Idempotent: exits immediately when .git already exists.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (Test-Path (Join-Path $root '.git')) {
    Write-Host '[skip] .git already exists; nothing to do.'
    exit 0
}

$messageDir = Join-Path $PSScriptRoot 'commit-messages'

Write-Host '[step] git init -b main'
git init -b main | Out-Null

Write-Host '[step] commit 1/2: workspace skeleton and ADRs'
git add package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.check.json .gitignore LICENSE README.md docs plugins scripts
git commit -F (Join-Path $messageDir '01-skeleton.txt')

Write-Host '[step] branch feat/kernel-baseline'
git switch -c feat/kernel-baseline | Out-Null

Write-Host '[step] commit 2/2: runtime kernel and tests'
git add packages
git commit -F (Join-Path $messageDir '02-kernel.txt')

Write-Host '[step] merge back into main (--no-ff)'
git switch main | Out-Null
git merge --no-ff feat/kernel-baseline -F (Join-Path $messageDir '03-merge-kernel.txt')

Write-Host ''
Write-Host '=== git log ==='
git --no-pager log --oneline --graph --decorate
Write-Host ''
Write-Host '=== git status ==='
git status --short
