# Push branches with bounded exponential backoff.
# GitHub access from this machine is flaky ("Recv failure: Connection was reset"),
# so a single failed push must not be treated as a hard failure of the milestone.
#
# ASCII-only on purpose (see bootstrap-git.ps1 for the PowerShell 5.1 ANSI note).

param([int] $Attempts = 6)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$branches = @('main', 'feat/host-extension-m1m2')

foreach ($branch in $branches) {
    $ok = $false
    for ($i = 1; $i -le $Attempts; $i++) {
        Write-Host ("[push] {0} — attempt {1}/{2}" -f $branch, $i, $Attempts)
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
}

Write-Host '[push] all branches pushed'
git --no-pager log --oneline -3
git status --short
