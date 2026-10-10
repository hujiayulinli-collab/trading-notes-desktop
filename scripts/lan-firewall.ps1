$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$journalPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $journalPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '请右键“配置局域网访问.cmd”，选择“以管理员身份运行”。'
}
$journalFirewallPort = 4319
if ($env:JOURNAL_PORT -and (-not [int]::TryParse($env:JOURNAL_PORT, [ref]$journalFirewallPort))) { throw '端口无效。' }
if ($journalFirewallPort -lt 1 -or $journalFirewallPort -gt 65535) { throw '端口无效。' }
$journalConfigured = 0
foreach ($journalNetwork in Get-NetIPConfiguration) {
  if (-not $journalNetwork.IPv4DefaultGateway) { continue }
  $journalAddresses = @($journalNetwork.IPv4Address.IPAddress | Where-Object {
    $_ -match '^10\.' -or $_ -match '^192\.168\.' -or $_ -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
  })
  if (-not $journalAddresses.Count) { continue }
  $journalRuleName = "PankouJournal-LAN-$journalFirewallPort-$($journalNetwork.InterfaceIndex)"
  $journalRuleOptions = @{
    Description = '盘口手记：仅允许当前接口的本地子网访问此项目 Node.js 的指定端口。'
    Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'
    Profile = @('Private', 'Public'); Protocol = 'TCP'; LocalPort = $journalFirewallPort
    Program = $journalNode; LocalAddress = $journalAddresses; RemoteAddress = 'LocalSubnet'
    InterfaceAlias = $journalNetwork.InterfaceAlias; EdgeTraversalPolicy = 'Block'
  }
  if (Get-NetFirewallRule -Name $journalRuleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $journalRuleName @journalRuleOptions | Out-Null
  } else {
    New-NetFirewallRule -Name $journalRuleName -DisplayName "盘口手记 局域网 $journalFirewallPort ($($journalNetwork.InterfaceAlias))" @journalRuleOptions | Out-Null
  }
  $journalConfigured++
  Write-Host "已允许 $($journalNetwork.InterfaceAlias) 的同网段设备访问端口 $journalFirewallPort。" -ForegroundColor Green
}
if (-not $journalConfigured) { throw '没有找到带网关的局域网 IPv4 接口，请先连接家庭或办公路由器。' }
