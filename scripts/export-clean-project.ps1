$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
& $journalNode (Join-Path $PSScriptRoot 'export-clean-project.mjs')
if ($LASTEXITCODE -ne 0) { throw '导出失败，请查看上方信息。' }
Write-Host '纯净项目已导出到 outputs，请分享其中的 ZIP 文件。' -ForegroundColor Green
