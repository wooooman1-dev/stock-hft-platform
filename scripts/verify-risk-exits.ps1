$ErrorActionPreference = "Stop"

$baseUrl = "http://127.0.0.1:8787"

function Invoke-PulseJson {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body = $null
  )

  $parameters = @{
    Uri         = "$baseUrl$Path"
    Method      = $Method
    ContentType = "application/json"
  }
  if ($null -ne $Body) {
    $parameters.Body = $Body | ConvertTo-Json -Depth 10
  }
  return Invoke-RestMethod @parameters
}

function Assert-Equal {
  param(
    [object]$Actual,
    [object]$Expected,
    [string]$Message
  )
  if ($Actual -ne $Expected) {
    throw "$Message (expected=$Expected, actual=$Actual)"
  }
}

function Assert-Contains {
  param(
    [string]$Actual,
    [string]$ExpectedFragment,
    [string]$Message
  )
  if ([string]::IsNullOrWhiteSpace($Actual) -or -not $Actual.Contains($ExpectedFragment)) {
    throw "$Message (expected fragment=$ExpectedFragment, actual=$Actual)"
  }
}

function Set-AutoStrategy {
  param([bool]$Enabled)
  Invoke-PulseJson -Method Post -Path "/api/strategy/auto" -Body @{ enabled = $Enabled } | Out-Null
}

function Reset-PaperAccount {
  Set-AutoStrategy -Enabled $false
  Invoke-PulseJson -Method Post -Path "/api/system/kill-switch" -Body @{ enabled = $false } | Out-Null
  Invoke-PulseJson -Method Post -Path "/api/paper/reset" -Body @{} | Out-Null
}

function Set-RiskSettings {
  param(
    [AllowNull()][object]$StopLossBps,
    [AllowNull()][object]$TakeProfitBps,
    [AllowNull()][object]$TrailingStopBps
  )

  return Invoke-PulseJson -Method Put -Path "/api/strategy/settings" -Body @{
    entryMinimumConfidence = 100
    exitMinimumConfidence  = 100
    maximumSpreadTicks     = 1
    orderQuantity          = 3
    cooldownMs             = 600000
    stopLossBps            = $StopLossBps
    takeProfitBps          = $TakeProfitBps
    trailingStopBps        = $TrailingStopBps
    maxHoldingMs           = $null
  }
}

function Add-ThreeSharePosition {
  param([string]$Scenario)

  $clientOrderId = "verify-$Scenario-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $order = Invoke-PulseJson -Method Post -Path "/api/paper/orders" -Body @{
    side          = "BUY"
    type          = "MARKET"
    quantity      = 3
    clientOrderId = $clientOrderId
  }
  Assert-Equal -Actual $order.status -Expected "FILLED" -Message "$Scenario 진입 주문이 FILLED가 아닙니다."
  Assert-Equal -Actual $order.filledQuantity -Expected 3 -Message "$Scenario 진입 체결수량이 3주가 아닙니다."

  $snapshot = Invoke-PulseJson -Method Get -Path "/api/snapshot"
  Assert-Equal -Actual $snapshot.account.position.quantity -Expected 3 -Message "$Scenario 진입 후 포지션이 3주가 아닙니다."
  return $snapshot
}

function Assert-ProtectiveExit {
  param(
    [object]$Snapshot,
    [string]$ReasonFragment,
    [string]$Scenario
  )

  Assert-Equal -Actual $Snapshot.account.position.quantity -Expected 0 -Message "$Scenario 후 포지션이 청산되지 않았습니다."
  $strategyOrders = @($Snapshot.account.orders | Where-Object {
    $_.side -eq "SELL" -and $_.source -eq "STRATEGY"
  })
  if ($strategyOrders.Count -eq 0) {
    throw "$Scenario 전략 매도 주문을 찾을 수 없습니다."
  }

  $exitOrder = $strategyOrders[0]
  Assert-Equal -Actual $exitOrder.status -Expected "FILLED" -Message "$Scenario 전략 매도 주문이 FILLED가 아닙니다."
  Assert-Equal -Actual $exitOrder.requestedQuantity -Expected 3 -Message "$Scenario 전략 매도 요청수량이 3주가 아닙니다."
  Assert-Equal -Actual $exitOrder.filledQuantity -Expected 3 -Message "$Scenario 전략 매도 체결수량이 3주가 아닙니다."
  Assert-Contains -Actual $exitOrder.clientOrderId -ExpectedFragment $ReasonFragment -Message "$Scenario 주문 ID에 청산 사유가 없습니다."
  Assert-Equal -Actual $Snapshot.strategy.riskState.quantity -Expected 0 -Message "$Scenario 후 위험 추적 수량이 초기화되지 않았습니다."
  if ($null -ne $Snapshot.strategy.riskState.openedAt) {
    throw "$Scenario 후 openedAt이 초기화되지 않았습니다."
  }
  if ($null -ne $Snapshot.strategy.riskState.peakPrice) {
    throw "$Scenario 후 peakPrice가 초기화되지 않았습니다."
  }

  Write-Host "PASS: $Scenario → $($exitOrder.clientOrderId)" -ForegroundColor Green
}

$originalSettings = $null

try {
  Write-Host "=== PulseHFT 위험청산 결정적 검증 시작 ===" -ForegroundColor Cyan
  $health = Invoke-PulseJson -Method Get -Path "/health"
  Assert-Equal -Actual $health.status -Expected "ok" -Message "서버 health 상태가 ok가 아닙니다."

  $originalSettings = Invoke-PulseJson -Method Get -Path "/api/strategy/settings"
  Reset-PaperAccount

  $initialSnapshot = Invoke-PulseJson -Method Get -Path "/api/snapshot"
  $tickSize = [int64]$initialSnapshot.tickSize
  $initialPrice = [int64]$initialSnapshot.lastPrice
  $pausedSnapshot = Invoke-PulseJson -Method Post -Path "/api/verification/market-tick" -Body @{
    lastPrice = $initialPrice
    depthSize = 1000
  }
  Assert-Equal -Actual $pausedSnapshot.system.verificationMode -Expected $true -Message "검증 모드가 활성화되지 않았습니다."
  Assert-Equal -Actual $pausedSnapshot.system.marketTimerPaused -Expected $true -Message "무작위 시장 타이머가 정지되지 않았습니다."

  Write-Host "검증 시장 고정: lastPrice=$initialPrice, tickSize=$tickSize" -ForegroundColor DarkCyan

  Reset-PaperAccount
  Set-RiskSettings -StopLossBps 100 -TakeProfitBps $null -TrailingStopBps $null | Out-Null
  $entry = Add-ThreeSharePosition -Scenario "stop-loss"
  $averagePrice = [double]$entry.account.position.averagePrice
  $stopPrice = [int64]([math]::Floor(($averagePrice * 0.98) / $tickSize) * $tickSize)
  Set-AutoStrategy -Enabled $true
  $snapshot = Invoke-PulseJson -Method Post -Path "/api/verification/market-tick" -Body @{
    lastPrice = $stopPrice
    depthSize = 1000
  }
  Assert-ProtectiveExit -Snapshot $snapshot -ReasonFragment "strategy-stop-loss" -Scenario "손절"

  Reset-PaperAccount
  Set-RiskSettings -StopLossBps $null -TakeProfitBps 200 -TrailingStopBps $null | Out-Null
  $entry = Add-ThreeSharePosition -Scenario "take-profit"
  $averagePrice = [double]$entry.account.position.averagePrice
  $profitPrice = [int64]([math]::Ceiling(($averagePrice * 1.03) / $tickSize) * $tickSize)
  Set-AutoStrategy -Enabled $true
  $snapshot = Invoke-PulseJson -Method Post -Path "/api/verification/market-tick" -Body @{
    lastPrice = $profitPrice
    depthSize = 1000
  }
  Assert-ProtectiveExit -Snapshot $snapshot -ReasonFragment "strategy-take-profit" -Scenario "익절"

  Reset-PaperAccount
  Set-RiskSettings -StopLossBps $null -TakeProfitBps $null -TrailingStopBps 100 | Out-Null
  $entry = Add-ThreeSharePosition -Scenario "trailing-stop"
  $averagePrice = [double]$entry.account.position.averagePrice
  $peakPrice = [int64]([math]::Ceiling(($averagePrice * 1.03) / $tickSize) * $tickSize)
  Set-AutoStrategy -Enabled $true
  $peakSnapshot = Invoke-PulseJson -Method Post -Path "/api/verification/market-tick" -Body @{
    lastPrice = $peakPrice
    depthSize = 1000
  }
  Assert-Equal -Actual $peakSnapshot.account.position.quantity -Expected 3 -Message "최고가 갱신 단계에서 포지션이 조기 청산됐습니다."
  Assert-Equal -Actual $peakSnapshot.strategy.riskState.peakPrice -Expected $peakPrice -Message "트레일링 최고가격이 갱신되지 않았습니다."

  $trailingPrice = [int64]([math]::Floor(($peakPrice * 0.98) / $tickSize) * $tickSize)
  $snapshot = Invoke-PulseJson -Method Post -Path "/api/verification/market-tick" -Body @{
    lastPrice = $trailingPrice
    depthSize = 1000
  }
  Assert-ProtectiveExit -Snapshot $snapshot -ReasonFragment "strategy-trailing-stop" -Scenario "트레일링 스톱"

  Write-Host "=== 손절·익절·트레일링 검증 전부 통과 ===" -ForegroundColor Green
}
finally {
  try { Set-AutoStrategy -Enabled $false } catch {}
  try { Invoke-PulseJson -Method Post -Path "/api/system/kill-switch" -Body @{ enabled = $false } | Out-Null } catch {}
  try { Invoke-PulseJson -Method Post -Path "/api/paper/reset" -Body @{} | Out-Null } catch {}
  if ($null -ne $originalSettings) {
    try { Invoke-PulseJson -Method Put -Path "/api/strategy/settings" -Body $originalSettings | Out-Null } catch {}
  }
  Write-Host "검증 계좌와 원래 전략 설정 복구 시도 완료" -ForegroundColor DarkGray
}
