param(
  [string]$BaseUrl = "http://127.0.0.1:8787",
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Invoke-JsonGet([string]$Path) {
  Invoke-RestMethod -Uri "$BaseUrl$Path" -Method Get -TimeoutSec 60
}

function Invoke-Refresh {
  Invoke-RestMethod `
    -Uri "$BaseUrl/api/recommendations/refresh" `
    -Method Post `
    -ContentType "application/json" `
    -Body "{}" `
    -TimeoutSec 180
}

Write-Host "[1/5] health 및 추천 스캐너 확인"
$health = Invoke-JsonGet "/health"
if ($null -eq $health.recommendations) {
  throw "health 응답에 recommendations가 없습니다."
}

Write-Host "[2/5] 추천 목록 강제 갱신 및 WebSocket 구독 시작"
$recommendations = Invoke-Refresh
if ($recommendations.state -eq "ERROR" -or $recommendations.state -eq "DISABLED") {
  $detail = $recommendations.errors | ConvertTo-Json -Depth 20
  throw "추천 스캐너를 시작할 수 없습니다. State=$($recommendations.state)`n$detail"
}
if ([int]$recommendations.universeCount -le 0 -or $recommendations.candidates.Count -le 0) {
  throw "WebSocket으로 감시할 추천 후보가 없습니다."
}
if ($null -eq $recommendations.executionBoundary) {
  throw "executionBoundary가 없습니다."
}
if ($recommendations.executionBoundary.automaticOrderConnected -ne $false) {
  throw "추천 목록이 자동주문에 연결되어 있습니다. 안전 경계 위반입니다."
}
if ($recommendations.executionBoundary.realtimeEntryReadyIsOrderSignal -ne $false) {
  throw "ENTRY_READY가 주문 신호로 설정되어 있습니다. 안전 경계 위반입니다."
}
if (@($recommendations.executionBoundary.actionableStages).Count -ne 0) {
  throw "actionableStages가 비어 있지 않습니다. 안전 경계 위반입니다."
}

Write-Host "[3/5] WebSocket 연결 및 구독 상태 대기"
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$connected = $false
$realtime = $null
while ((Get-Date) -lt $deadline) {
  $recommendations = Invoke-JsonGet "/api/recommendations"
  $realtime = $recommendations.status.dataSources.realtime
  if ($null -eq $realtime) {
    throw "추천 응답에 status.dataSources.realtime이 없습니다."
  }
  if ($realtime.state -eq "ERROR") {
    $detail = $realtime.lastError | ConvertTo-Json -Depth 10
    throw "KIS WebSocket 연결 오류입니다.`n$detail"
  }
  if ($realtime.connected -eq $true -and [int]$realtime.activeSubscriptionCount -gt 0) {
    $connected = $true
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $connected) {
  $detail = $realtime | ConvertTo-Json -Depth 20
  throw "제한 시간 안에 KIS WebSocket 연결·구독이 확인되지 않았습니다.`n$detail"
}

Write-Host "[4/5] 후보별 실시간 상태와 주문 분리 확인"
$allowedStates = @(
  "SCANNED",
  "WATCH",
  "REALTIME_CONFIRMING",
  "ENTRY_READY",
  "BLOCKED",
  "STALE",
  "DISCONNECTED"
)
$liveDataCount = 0
foreach ($candidate in @($recommendations.candidates)) {
  if ($null -eq $candidate.realtime) {
    throw "후보 $($candidate.symbol)에 realtime 객체가 없습니다."
  }
  if ($allowedStates -notcontains [string]$candidate.realtime.state) {
    throw "후보 $($candidate.symbol)의 알 수 없는 실시간 상태입니다: $($candidate.realtime.state)"
  }
  if ($candidate.realtime.automaticOrderConnected -ne $false) {
    throw "후보 $($candidate.symbol)의 실시간 상태가 자동주문에 연결되어 있습니다."
  }
  if ($null -ne $candidate.realtime.latestAt) {
    $liveDataCount += 1
  }
}

Write-Host "[5/5] 비밀정보 노출 여부 확인"
$json = $recommendations | ConvertTo-Json -Depth 40
$forbidden = @(
  "appSecret",
  "appKey",
  "accessToken",
  "approvalKey",
  "approval_key",
  "secretkey",
  "clientSecret",
  "crtfc_key"
)
foreach ($word in $forbidden) {
  if ($json -match $word) {
    throw "응답에서 금지된 비밀정보 필드가 발견되었습니다: $word"
  }
}

Write-Host "KIS REALTIME CONNECTION VERIFICATION PASSED"
Write-Host "Connection=$($realtime.connected) State=$($realtime.state) Subscriptions=$($realtime.activeSubscriptionCount) Candidates=$($recommendations.candidates.Count) LiveDataCandidates=$liveDataCount"
if ($liveDataCount -eq 0) {
  Write-Warning "WebSocket 연결·구독은 확인됐지만 실시간 호가·체결 데이터는 아직 수신되지 않았습니다. 장 마감일에는 정상일 수 있으며 ENTRY_READY 검증은 정규 장중에 다시 실행해야 합니다."
}
