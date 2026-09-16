# Push the CURRENT branch with bounded exponential backoff.
# GitHub access from this machine is flaky ("Recv failure: Connection was reset"),
# so a single failed push must not be treated as a hard failure of the milestone.
#
# 之前这里硬编码了 main + 一个早已合并的 feature 分支；那个 feature 分支不存在或已合并时
# 会让脚本在最后一步白等重试。现在只推当前分支（detached HEAD 直接报错退出）。
#
# ASCII-only on purpose (see bootstrap-git.ps1 for the PowerShell 5.1 ANSI note).

param([int] $Attempts = 6)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$branch = (git rev-parse --abbrev-ref HEAD | Select-Object -First 1).Trim()
if ([string]::IsNullOrWhiteSpace($branch) -or $branch -eq 'HEAD') {
    Write-Host '[push] cannot determine the current branch (detached HEAD?)'
    exit 1
}
Write-Host ("[push] branch: {0}" -f $branch)

$ok = $false
for ($i = 1; $i -le $Attempts; $i++) {
    Write-Host ("[push] {0} - attempt {1}/{2}" -f $branch, $i, $Attempts)
    git push origin $branch 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -eq 0) {
        $ok = $true
        break
    }
    if ($i -lt $Attempts) {
        $wait = 3 * $i
        Write-Host ("[push] retry in {0}s" -f $wait)
        Start-Sleep -Seconds $wait
    }
}

if (-not $ok) {
    Write-Host ("[push] FAILED: {0} after {1} attempts" -f $branch, $Attempts)
    exit 1
}

Write-Host '[push] pushed'
git --no-pager log --oneline -3
git status --short
