param(
  [string]$BaseUrl = "http://127.0.0.1:8787"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Invoke-JsonGet([string]$Path) {
  Invoke-RestMethod -Uri "$BaseUrl$Path" -Method Get -TimeoutSec 60
}

Write-Host "[1/3] health 확인"
$health = Invoke-JsonGet "/health"
if ($null -eq $health.recommendations) { throw "health 응답에 recommendations가 없습니다." }

Write-Host "[2/3] 추천 목록 강제 갱신"
$recommendations = Invoke-RestMethod `
  -Uri "$BaseUrl/api/recommendations/refresh" `
  -Method Post `
  -ContentType "application/json" `
  -Body "{}" `
  -TimeoutSec 120

if ($null -eq $recommendations.executionBoundary) { throw "executionBoundary가 없습니다." }
if ($recommendations.executionBoundary.automaticOrderConnected -ne $false) {
  throw "추천 목록이 자동주문에 연결되어 있습니다. 안전 경계 위반입니다."
}
if ($null -eq $recommendations.status.dataSources.kis) { throw "KIS 데이터 상태가 없습니다." }
if ($recommendations.state -eq "ERROR") {
  $detail = $recommendations.errors | ConvertTo-Json -Depth 20
  throw "추천 데이터 조회가 실패했습니다.`n$detail"
}
if ($recommendations.state -eq "DISABLED") {
  throw "추천 데이터 수집기가 비활성화되어 있습니다."
}
if ([int]$recommendations.universeCount -le 0) {
  throw "추천 후보 모집단이 비어 있습니다."
}

Write-Host "[3/3] 비밀정보 노출 여부 확인"
$json = $recommendations | ConvertTo-Json -Depth 30
$forbidden = @("appSecret", "appKey", "accessToken", "clientSecret", "crtfc_key")
foreach ($word in $forbidden) {
  if ($json -match $word) { throw "응답에서 금지된 비밀정보 필드가 발견되었습니다: $word" }
}

Write-Host "BUY RECOMMENDATION VERIFICATION PASSED"
Write-Host "State=$($recommendations.state) Candidates=$($recommendations.candidates.Count) Universe=$($recommendations.universeCount)"
