param([switch]$NoBrowser, [switch]$Lan, [switch]$Restart)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
if (-not (Test-Path -LiteralPath (Join-Path $journalRoot 'node_modules\sharp'))) { throw '缺少运行依赖，请先运行“安装与构建.cmd”。' }
if (-not (Test-Path -LiteralPath (Join-Path $journalRoot 'dist\client\index.html'))) { throw '页面尚未构建，请先运行“安装与构建.cmd”。' }
$journalPort = 4319
if ($env:JOURNAL_PORT -and (-not [int]::TryParse($env:JOURNAL_PORT, [ref]$journalPort))) { throw '端口无效。' }
if ($journalPort -lt 1 -or $journalPort -gt 65535) { throw '端口必须是 1–65535 之间的整数。' }
$journalUrl = "http://127.0.0.1:$journalPort/"
$journalEntry = Join-Path $journalRoot 'server\index.mjs'
$journalLogs = Join-Path $journalRoot 'logs'
$journalPidFile = Join-Path $journalLogs 'server.pid'
$journalRunning = $false
try {
  $journalResponse = Invoke-RestMethod -Uri ($journalUrl + 'api/health') -TimeoutSec 2
  $journalRunning = $journalResponse.app -eq 'pankou-journal'
} catch { }
if ($journalRunning) {
  $journalExistingPid = 0
  if (-not (Test-Path -LiteralPath $journalPidFile) -or -not [int]::TryParse((Get-Content -LiteralPath $journalPidFile -Raw).Trim(), [ref]$journalExistingPid)) {
    throw "端口 $journalPort 已被另一份盘口手记使用，请先关闭那份程序。"
  }
  $journalExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $journalExistingPid"
  $journalListener = Get-NetTCPConnection -LocalPort $journalPort -State Listen -ErrorAction Stop
  if (-not $journalExistingProcess -or
      $journalExistingProcess.ExecutablePath -ne $journalNode -or
      -not $journalExistingProcess.CommandLine.Contains(('"' + $journalEntry + '"')) -or
      -not ($journalListener.OwningProcess -contains $journalExistingPid)) {
    throw "端口 $journalPort 不属于当前项目，未停止任何进程。"
  }
  $journalWasLan = $journalResponse.networkMode -eq 'lan'
  if ($Restart -or ($Lan.IsPresent -ne $journalWasLan)) {
    Stop-Process -Id $journalExistingPid -Force
    Wait-Process -Id $journalExistingPid -Timeout 10 -ErrorAction SilentlyContinue
    $journalRunning = $false
  }
}
if (-not $journalRunning) {
  New-Item -ItemType Directory -Path $journalLogs -Force | Out-Null
  $env:JOURNAL_PORT = [string]$journalPort
  $env:JOURNAL_LAN = if ($Lan) { '1' } else { '0' }
  $journalProcess = Start-Process -FilePath $journalNode -ArgumentList ('"' + $journalEntry + '"') -WorkingDirectory $journalRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $journalLogs 'server.log') -RedirectStandardError (Join-Path $journalLogs 'server-error.log')
  Set-Content -LiteralPath $journalPidFile -Value $journalProcess.Id
  for ($journalAttempt = 0; $journalAttempt -lt 30; $journalAttempt++) {
    Start-Sleep -Milliseconds 300
    try {
      $journalResponse = Invoke-RestMethod -Uri ($journalUrl + 'api/health') -TimeoutSec 2
      if ($journalResponse.app -eq 'pankou-journal' -and (($journalResponse.networkMode -eq 'lan') -eq $Lan.IsPresent)) { $journalRunning = $true; break }
    } catch { }
    if ($journalProcess.HasExited) { break }
  }
  if (-not $journalRunning) {
    $journalFailure = Get-Content -LiteralPath (Join-Path $journalLogs 'server-error.log') -Raw -ErrorAction SilentlyContinue
    throw "启动失败，请查看 logs 文件夹。`n$journalFailure"
  }
}
Write-Host "本机访问：$journalUrl" -ForegroundColor Green
if ($Lan) {
  foreach ($journalLanUrl in $journalResponse.lanUrls) { Write-Host "同一局域网电脑访问：$journalLanUrl" -ForegroundColor Cyan }
  if (-not $journalResponse.lanUrls.Count) { Write-Warning '尚未检测到可用的局域网 IPv4 地址。' }
}
if (-not $NoBrowser) { Start-Process $journalUrl }
