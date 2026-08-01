param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dataDir = Join-Path $root ".pulsehft"
$credentialPath = Join-Path $dataDir "kis-prod-read-only.json"
$launcherPath = Join-Path $dataDir "start-kis-prod-read-only.ps1"

$appKey = (Read-Host "한국투자 실전 App Key").Trim()
if ([string]::IsNullOrWhiteSpace($appKey)) {
    throw "App Key가 비어 있습니다."
}

$secureSecret = Read-Host "한국투자 실전 App Secret (화면에 표시되지 않음)" -AsSecureString
$secretPointer = [IntPtr]::Zero
$appSecret = $null

try {
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $appSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    if ([string]::IsNullOrWhiteSpace($appSecret)) {
        throw "App Secret이 비어 있습니다."
    }

    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

    $credentialJson = @{
        appKey = $appKey
        appSecret = $appSecret
    } | ConvertTo-Json

    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($credentialPath, $credentialJson + [Environment]::NewLine, $utf8WithoutBom)

    $escapedRoot = $root.Replace("'", "''")
    $launcher = @"
`$ErrorActionPreference = "Stop"
`$env:PULSEHFT_KIS_MODE = "PROD_READ_ONLY"
Set-Location '$escapedRoot'
node server/app.js
"@
    [System.IO.File]::WriteAllText($launcherPath, $launcher, $utf8WithoutBom)

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $dataDir /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "로컬 자격정보 디렉터리 권한 설정에 실패했습니다."
    }
    & icacls.exe $credentialPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "자격정보 파일 권한 설정에 실패했습니다."
    }
    & icacls.exe $launcherPath /inheritance:r /grant:r "${identity}:F" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "실행 파일 권한 설정에 실패했습니다."
    }
}
finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    $appSecret = $null
    $secureSecret = $null
}

Write-Host ""
Write-Host "한국투자 실전 시세 전용 자격정보 저장 완료"
Write-Host "저장 위치: $credentialPath"
Write-Host "계좌번호는 저장하지 않았습니다."
Write-Host "주문 API는 제공되지 않습니다."
Write-Host ""
Write-Host "실행 명령:"
Write-Host "& .\.pulsehft\start-kis-prod-read-only.ps1"
