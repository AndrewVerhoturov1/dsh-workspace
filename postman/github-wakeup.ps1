[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$EventPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepositoryFullName = 'AndrewVerhoturov1/dsh-workspace'
$TitlePattern = '^POSTMAN (REQ_[A-Za-z0-9_-]{1,80})$'
$RequestIdPattern = '^REQ_[A-Za-z0-9_-]{1,80}$'
$AllowedStatuses = @('WAITING', 'READY')

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Text)
        $hash = $sha256.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Read-EventJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Event JSON does not exist: $Path"
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'Event JSON is empty'
    }

    try {
        return ($raw | ConvertFrom-Json)
    }
    catch {
        throw "Event JSON is malformed: $($_.Exception.Message)"
    }
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object -or -not ($Object.PSObject.Properties.Name -contains $Name)) {
        throw "Missing event field: $Name"
    }

    $value = $Object.$Name
    if ($null -eq $value) {
        throw "Event field is null: $Name"
    }

    return $value
}

function Parse-PostmanBody {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Body)

    $normalized = $Body -replace "`r`n", "`n" -replace "`r", "`n"
    $lines = $normalized.Split("`n")
    $separatorIndex = -1

    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -eq '') {
            $separatorIndex = $index
            break
        }
    }

    if ($separatorIndex -lt 1) {
        throw 'Issue body must contain a non-empty metadata header followed by a blank line'
    }

    $metadata = @{}
    foreach ($line in @($lines[0..($separatorIndex - 1)])) {
        if ($line -cnotmatch '^([a-z][a-z0-9_]*):[ \t]*(.*)$') {
            throw "Malformed metadata line"
        }

        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($metadata.ContainsKey($key)) {
            throw "Duplicate metadata field: $key"
        }
        if ($key -notin @('request_id', 'status', 'protocol_version')) {
            throw "Unknown metadata field: $key"
        }
        $metadata[$key] = $value
    }

    foreach ($requiredKey in @('request_id', 'status', 'protocol_version')) {
        if (-not $metadata.ContainsKey($requiredKey) -or [string]::IsNullOrWhiteSpace($metadata[$requiredKey])) {
            throw "Missing metadata field: $requiredKey"
        }
    }

    $requestId = [string]$metadata['request_id']
    if ($requestId -cnotmatch $RequestIdPattern) {
        throw 'request_id does not match the required format'
    }

    $status = [string]$metadata['status']
    if ($status -cnotin $AllowedStatuses) {
        throw "Unsupported status: $status"
    }

    if ([string]$metadata['protocol_version'] -cne '1') {
        throw 'protocol_version must be 1'
    }

    $response = ''
    if ($separatorIndex -lt ($lines.Count - 1)) {
        $response = $lines[($separatorIndex + 1)..($lines.Count - 1)] -join "`n"
    }

    return [pscustomobject]@{
        RequestId      = $requestId
        Status         = $status
        ProtocolVersion = 1
        Response       = $response
    }
}

function Get-SignalPath {
    param([Parameter(Mandatory = $true)][string]$RequestId)

    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        throw 'LOCALAPPDATA is not defined'
    }

    $signalDirectory = Join-Path $localAppData 'DSH\Postman\signals'
    [void](New-Item -ItemType Directory -Path $signalDirectory -Force)
    return (Join-Path $signalDirectory ($RequestId + '.json'))
}

function Write-AtomicSignal {
    param(
        [Parameter(Mandatory = $true)][string]$SignalPath,
        [Parameter(Mandatory = $true)]$Signal
    )

    $mutex = [System.Threading.Mutex]::new($false, 'Local\DSH_Postman_GitHubWakeup')
    $lockTaken = $false
    $temporaryPath = $null

    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
        if (-not $lockTaken) {
            throw 'Timed out waiting for the local signal lock'
        }

        if (Test-Path -LiteralPath $SignalPath -PathType Leaf) {
            $existing = Get-Content -LiteralPath $SignalPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([string]$existing.deliveryKey -ceq [string]$Signal.deliveryKey) {
                return 'duplicate'
            }
        }

        $temporaryPath = '{0}.{1}.tmp' -f $SignalPath, ([guid]::NewGuid().ToString('N'))
        $json = $Signal | ConvertTo-Json -Depth 10
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($temporaryPath, $json, $utf8)

        if (Test-Path -LiteralPath $SignalPath -PathType Leaf) {
            # .NET's overwrite move maps to the Windows replace-rename operation.
            [System.IO.File]::Move($temporaryPath, $SignalPath, $true)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $SignalPath)
        }
        $temporaryPath = $null
        return 'written'
    }
    finally {
        if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        if ($lockTaken) {
            [void]$mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

try {
    $event = Read-EventJson -Path $EventPath
    $action = [string](Get-PropertyValue -Object $event -Name 'action')
    if ($action -cne 'edited') {
        Write-Output "IGNORED action=$action"
        exit 0
    }

    $repository = Get-PropertyValue -Object $event -Name 'repository'
    $repositoryName = [string](Get-PropertyValue -Object $repository -Name 'full_name')
    if ($repositoryName -cne $RepositoryFullName) {
        throw "Unexpected repository: $repositoryName"
    }

    $issue = Get-PropertyValue -Object $event -Name 'issue'
    if ($issue.PSObject.Properties.Name -contains 'pull_request') {
        throw 'Pull request events are not accepted as Postman issue events'
    }

    $issueNumberValue = Get-PropertyValue -Object $issue -Name 'number'
    [long]$issueNumber = 0
    if (-not [long]::TryParse([string]$issueNumberValue, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$issueNumber) -or $issueNumber -le 0) {
        throw 'Issue number is invalid'
    }

    $title = [string](Get-PropertyValue -Object $issue -Name 'title')
    if ($title -cnotmatch $TitlePattern) {
        Write-Output 'IGNORED title does not match POSTMAN protocol'
        exit 0
    }
    $titleRequestId = [string]$Matches[1]

    $bodyValue = Get-PropertyValue -Object $issue -Name 'body'
    $body = [string]$bodyValue
    $parsed = Parse-PostmanBody -Body $body
    if ($parsed.RequestId -cne $titleRequestId) {
        throw 'Title request_id and body request_id do not match'
    }

    if ($parsed.Status -cne 'READY') {
        Write-Output "IGNORED status=$($parsed.Status)"
        exit 0
    }

    $updatedAt = [string](Get-PropertyValue -Object $issue -Name 'updated_at')
    [DateTimeOffset]$updatedAtValue = [DateTimeOffset]::MinValue
    $timestampStyles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [DateTimeOffset]::TryParse($updatedAt, [Globalization.CultureInfo]::InvariantCulture, $timestampStyles, [ref]$updatedAtValue)) {
        throw 'Issue updated_at is invalid'
    }

    $canonicalUpdatedAt = $updatedAtValue.UtcDateTime.ToString('o')
    $bodyHash = Get-Sha256Hex -Text $body
    $deliveryKey = '{0}|{1}|{2}|{3}' -f $parsed.RequestId, $issueNumber, $canonicalUpdatedAt, $bodyHash
    $signalPath = Get-SignalPath -RequestId $parsed.RequestId
    $receivedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $deliveryId = $null
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) {
        $deliveryId = '{0}/{1}' -f $env:GITHUB_RUN_ID, $(if ($env:GITHUB_RUN_ATTEMPT) { $env:GITHUB_RUN_ATTEMPT } else { '1' })
    }

    $signal = [ordered]@{
        protocolVersion = $parsed.ProtocolVersion
        requestId = $parsed.RequestId
        issueNumber = $issueNumber
        repository = $repositoryName
        status = 'READY'
        response = $parsed.Response
        githubUpdatedAt = $updatedAtValue.UtcDateTime.ToString('o')
        receivedAt = $receivedAt
        bodySha256 = $bodyHash
        deliveryKey = $deliveryKey
    }
    if ($deliveryId) {
        $signal.deliveryId = $deliveryId
    }

    $writeResult = Write-AtomicSignal -SignalPath $signalPath -Signal $signal
    if ($writeResult -eq 'duplicate') {
        Write-Output "SIGNAL_DUPLICATE request_id=$($parsed.RequestId) issue=$issueNumber"
    }
    else {
        Write-Output "SIGNAL_WRITTEN request_id=$($parsed.RequestId) issue=$issueNumber path=$signalPath"
    }
    exit 0
}
catch {
    [Console]::Error.WriteLine(('POSTMAN_WAKEUP_REJECTED: {0}' -f $_.Exception.Message))
    exit 1
}
