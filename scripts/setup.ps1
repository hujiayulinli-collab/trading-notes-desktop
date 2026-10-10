$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
Set-Location -LiteralPath $journalRoot
if (-not $journalPnpm) {
  $journalBundledPnpm = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
  if (Test-Path -LiteralPath $journalBundledPnpm) { $journalPnpm = $journalBundledPnpm }
}
if (-not $journalPnpm) { throw '请先安装 pnpm，然后重新运行此文件。' }
$journalInstallArgs = @('install', '--frozen-lockfile')
if ($journalPnpmStore) { $journalInstallArgs += @('--store-dir', $journalPnpmStore) }
if ($journalPnpmCache) { $journalInstallArgs += @('--cache-dir', $journalPnpmCache) }
& $journalPnpm @journalInstallArgs
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请查看上方信息。' }
& $journalNode 'node_modules/typescript/bin/tsc' --noEmit
if ($LASTEXITCODE -ne 0) { throw '检查失败。' }
& $journalNode 'scripts/build.mjs'
if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上方信息。' }
Write-Host '准备完成。请双击“启动盘口手记.cmd”。' -ForegroundColor Green
