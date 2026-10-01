param(
  [string]$BaseUrl = "http://127.0.0.1:8787",
  [string]$DataDir = ".\.pulsehft"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Invoke-JsonGet([string]$Path) {
  Invoke-RestMethod -Uri "$BaseUrl$Path" -Method Get -TimeoutSec 60
}

Write-Host "[1/5] 연구 기록 상태 확인"
$before = Invoke-JsonGet "/api/recommendations/research/status"
if ($before.enabled -ne $true) {
  throw "실시간 연구 기록이 비활성화되어 있습니다."
}
if ($before.automaticOrderConnected -ne $false) {
  throw "연구 기록이 자동주문에 연결되어 있습니다."
}

Write-Host "[2/5] 추천 스캔 강제 갱신"
$recommendations = Invoke-RestMethod `
  -Uri "$BaseUrl/api/recommendations/refresh" `
  -Method Post `
  -ContentType "application/json" `
  -Body "{}" `
  -TimeoutSec 180
if ($recommendations.state -eq "ERROR" -or $recommendations.state -eq "DISABLED") {
  throw "추천 스캔 실패: $($recommendations.state)"
}

Write-Host "[3/5] 기록 flush 대기"
Start-Sleep -Seconds 2
$after = Invoke-JsonGet "/api/recommendations/research/status"
if ($after.state -eq "ERROR") {
  $detail = $after.lastError | ConvertTo-Json -Depth 10
  throw "연구 기록 쓰기 오류입니다.`n$detail"
}
if ([int]$after.droppedEvents -ne 0) {
  throw "연구 기록에서 이벤트가 누락됐습니다: $($after.droppedEvents)"
}
if ([int]$after.eventCount -le [int]$before.eventCount) {
  throw "추천 갱신 후 연구 이벤트 수가 증가하지 않았습니다."
}
if ([int]$after.typeCounts.SCANNER_REFRESH -le 0) {
  throw "SCANNER_REFRESH 이벤트가 기록되지 않았습니다."
}
if ([string]::IsNullOrWhiteSpace([string]$after.fileName)) {
  throw "연구 기록 파일명이 없습니다."
}

Write-Host "[4/5] JSONL 파일과 재생 엔진 확인"
$filePath = Join-Path (Join-Path $DataDir "realtime-research") $after.fileName
if (-not (Test-Path -LiteralPath $filePath)) {
  throw "연구 기록 파일을 찾을 수 없습니다: $filePath"
}
$file = Get-Item -LiteralPath $filePath
if ($file.Length -le 0) {
  throw "연구 기록 파일이 비어 있습니다."
}
$replayJson = (& node ".\scripts\replay-kis-realtime.js" $filePath "--horizons=1000,5000") | Out-String
$replay = $replayJson | ConvertFrom-Json
if ($replay.model -ne "OBSERVATIONAL_NO_FILL_MODEL") {
  throw "재생 결과 모델이 예상과 다릅니다: $($replay.model)"
}
if ($replay.automaticOrderConnected -ne $false) {
  throw "재생 엔진이 자동주문에 연결되어 있습니다."
}
if ([int]$replay.eventCount -le 0) {
  throw "재생할 이벤트가 없습니다."
}

$acceptedEventsAtStatus = [int64]$after.eventCount
$queuedEventsAtStatus = [int64]$after.queuedEvents
$flushedEventsAtStatus = $acceptedEventsAtStatus - $queuedEventsAtStatus
if ($flushedEventsAtStatus -lt 0) {
  throw "연구 기록 상태의 eventCount와 queuedEvents가 모순됩니다."
}
if ([int64]$replay.eventCount -lt $flushedEventsAtStatus) {
  throw "상태 조회 시 이미 flush된 이벤트보다 재생된 이벤트가 적습니다. FlushedAtStatus=$flushedEventsAtStatus ReplayEvents=$($replay.eventCount)"
}

Write-Host "[5/5] 비밀정보 노출 여부 확인"
$journalText = Get-Content -LiteralPath $filePath -Raw -Encoding utf8
$forbidden = @(
  "appSecret",
  "appKey",
  "accessToken",
  "approvalKey",
  "approval_key",
  "secretkey",
  "clientSecret",
  "accountNumber"
)
foreach ($word in $forbidden) {
  if ($journalText -match $word) {
    throw "연구 기록에서 금지된 비밀정보 필드가 발견되었습니다: $word"
  }
}

Write-Host "REALTIME RESEARCH VERIFICATION PASSED"
Write-Host "File=$($after.fileName) AcceptedEvents=$acceptedEventsAtStatus QueuedAtStatus=$queuedEventsAtStatus FlushedAtStatus=$flushedEventsAtStatus Bytes=$($after.bytesWritten) ReplayEvents=$($replay.eventCount) Signals=$($replay.signals.Count)"
if ([int64]$replay.eventCount -gt $flushedEventsAtStatus) {
  Write-Host "ReplayEvents에는 상태 조회 후 추가로 flush된 실시간 이벤트가 포함되어 있습니다."
}
