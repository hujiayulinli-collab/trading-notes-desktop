$journalRoot = Split-Path -Parent $PSScriptRoot
$journalRuntimeFile = Join-Path $journalRoot '.local-runtime.json'
$journalRuntime = $null
if (Test-Path -LiteralPath $journalRuntimeFile) {
  $journalRuntime = Get-Content -LiteralPath $journalRuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
$journalNode = $null
if ($journalRuntime.node -and (Test-Path -LiteralPath $journalRuntime.node)) {
  $journalNode = $journalRuntime.node
} else {
  $journalNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
if (-not $journalNode) {
  $journalBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $journalBundledNode) { $journalNode = $journalBundledNode }
}
if (-not $journalNode) { throw '缺少 Node.js，请先配置 Node.js 22.18 或更高版本。' }
$journalNodeVersion = & $journalNode --version
if ($LASTEXITCODE -ne 0 -or [version]($journalNodeVersion.TrimStart('v')) -lt [version]'22.18.0') {
  throw 'Node.js 版本过低，请使用 22.18 或更高版本。'
}
$env:Path = (Split-Path -Parent $journalNode) + ';' + $env:Path
$journalPnpm = $null
if ($journalRuntime.pnpm -and (Test-Path -LiteralPath $journalRuntime.pnpm)) {
  $journalPnpm = $journalRuntime.pnpm
  $env:Path = (Split-Path -Parent $journalPnpm) + ';' + $env:Path
} else {
  $journalPnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
}
if ($journalRuntime.npmCache) { $env:npm_config_cache = $journalRuntime.npmCache }
if ($journalRuntime.pnpmHome) { $env:PNPM_HOME = $journalRuntime.pnpmHome }
if ($journalRuntime.pnpmStore) { $env:PNPM_CONFIG_STORE_DIR = $journalRuntime.pnpmStore }
if ($journalRuntime.pnpmCache) { $env:PNPM_CONFIG_CACHE_DIR = $journalRuntime.pnpmCache }
if ($journalRuntime.pnpmHome) { $env:PNPM_CONFIG_STATE_DIR = Join-Path $journalRuntime.pnpmHome 'state' }
if ($journalRuntime.temp) { $env:TEMP = $journalRuntime.temp; $env:TMP = $journalRuntime.temp }
$journalPnpmStore = $journalRuntime.pnpmStore
$journalPnpmCache = $journalRuntime.pnpmCache
