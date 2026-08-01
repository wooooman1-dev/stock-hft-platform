param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = Join-Path $root ".pulsehft"
$credentialPath = Join-Path $dataDir "kis-paper.json"
$launcherPath = Join-Path $dataDir "start-kis-paper-trading.ps1"

$secureAppKey = Read-Host "한국투자 모의투자 전용 App Key (화면에 표시되지 않음)" -AsSecureString
$secureAppSecret = Read-Host "한국투자 모의투자 전용 App Secret (화면에 표시되지 않음)" -AsSecureString
$accountNumber = (Read-Host "한국투자 모의투자 계좌번호 앞 8자리").Trim()
$accountProductCode = (Read-Host "계좌상품코드 2자리 (기본 01)").Trim()
if ([string]::IsNullOrWhiteSpace($accountProductCode)) { $accountProductCode = "01" }

$appKeyPointer = [IntPtr]::Zero
$appSecretPointer = [IntPtr]::Zero
$appKey = $null
$appSecret = $null

try {
    $appKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAppKey)
    $appSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAppSecret)
    $appKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($appKeyPointer)
    $appSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($appSecretPointer)

    if ([string]::IsNullOrWhiteSpace($appKey)) { throw "모의투자 App Key가 비어 있습니다." }
    if ([string]::IsNullOrWhiteSpace($appSecret)) { throw "모의투자 App Secret이 비어 있습니다." }
    if ($accountNumber -notmatch '^\d{8}$') { throw "모의투자 계좌번호 앞자리는 숫자 8자리여야 합니다." }
    if ($accountProductCode -notmatch '^\d{2}$') { throw "계좌상품코드는 숫자 2자리여야 합니다." }

    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

    $credentialJson = @{
        appKey = $appKey
        appSecret = $appSecret
        accountNumber = $accountNumber
        accountProductCode = $accountProductCode
    } | ConvertTo-Json

    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($credentialPath, $credentialJson + [Environment]::NewLine, $utf8WithoutBom)

    $escapedRoot = $root.Replace("'", "''")
    $launcher = @"
`$ErrorActionPreference = "Stop"
`$env:PULSEHFT_KIS_PAPER_MODE = "PAPER_TRADING"
Set-Location '$escapedRoot'
node server/app.js
"@
    [System.IO.File]::WriteAllText($launcherPath, $launcher, $utf8WithoutBom)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $dataDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "로컬 자격정보 디렉터리 권한 설정에 실패했습니다." }
    & icacls.exe $credentialPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "모의투자 자격정보 파일 권한 설정에 실패했습니다." }
    & icacls.exe $launcherPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "모의투자 실행 파일 권한 설정에 실패했습니다." }
}
finally {
    if ($appKeyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($appKeyPointer) }
    if ($appSecretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($appSecretPointer) }
    $appKey = $null
    $appSecret = $null
    $secureAppKey = $null
    $secureAppSecret = $null
}

Write-Host ""
Write-Host "한국투자 모의투자 전용 자격정보 저장 완료"
Write-Host "저장 위치: $credentialPath"
Write-Host "계좌번호는 상태 API에서 마스킹됩니다."
Write-Host "실전 주문 기능은 포함되지 않습니다."
Write-Host "자동전략은 한국투자 모의주문에 연결되지 않습니다."
Write-Host ""
Write-Host "실행 명령:"
Write-Host "& .\.pulsehft\start-kis-paper-trading.ps1"
