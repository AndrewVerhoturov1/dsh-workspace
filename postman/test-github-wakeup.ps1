[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$handlerPath = Join-Path $PSScriptRoot 'github-wakeup.ps1'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-postman-wakeup-' + [guid]::NewGuid().ToString('N'))
$oldLocalAppData = $env:LOCALAPPDATA
$passed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
    $script:passed++
}

function New-IssueEvent {
    param(
        [int]$Number,
        [string]$Title,
        [string]$Body,
        [string]$UpdatedAt = '2026-08-27T20:00:00Z',
        [bool]$PullRequest = $false
    )

    $issue = [ordered]@{
        number = $Number
        title = $Title
        body = $Body
        updated_at = $UpdatedAt
    }
    if ($PullRequest) {
        $issue.pull_request = [ordered]@{ url = 'https://api.github.com/repos/AndrewVerhoturov1/dsh-workspace/pulls/99' }
    }

    return [ordered]@{
        action = 'edited'
        repository = [ordered]@{ full_name = 'AndrewVerhoturov1/dsh-workspace' }
        issue = $issue
    }
}

function Invoke-Handler {
    param($Event)

    $eventPath = Join-Path $tempRoot ('event-' + [guid]::NewGuid().ToString('N') + '.json')
    $Event | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $eventPath -Encoding UTF8
    try {
        $output = @(& $PSHOME\pwsh.exe -NoLogo -NoProfile -File $handlerPath -EventPath $eventPath 2>&1)
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = (($output | ForEach-Object { $_.ToString() }) -join "`n")
        }
    }
    finally {
        Remove-Item -LiteralPath $eventPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    $env:LOCALAPPDATA = $tempRoot
    $signalDirectory = Join-Path $tempRoot 'DSH\Postman\signals'

    $readyBody = "request_id: REQ_PROBE_001`nstatus: READY`nprotocol_version: 1`n`nPOSTMAN PROBE RESPONSE"
    $readyResult = Invoke-Handler (New-IssueEvent -Number 700 -Title 'POSTMAN REQ_PROBE_001' -Body $readyBody)
    Assert-True ($readyResult.ExitCode -eq 0) 'valid READY event exits successfully'
    Assert-True ($readyResult.Output -like '*SIGNAL_WRITTEN*') 'valid READY event writes signal'

    $signalPath = Join-Path $signalDirectory 'REQ_PROBE_001.json'
    Assert-True (Test-Path -LiteralPath $signalPath -PathType Leaf) 'signal file exists'
    $signal = Get-Content -LiteralPath $signalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($signal.requestId -ceq 'REQ_PROBE_001') 'request_id is preserved'
    Assert-True ([int]$signal.issueNumber -eq 700) 'issue number is preserved separately'
    Assert-True ($signal.response -ceq 'POSTMAN PROBE RESPONSE') 'response is preserved'
    Assert-True ($signal.status -ceq 'READY') 'signal status is READY'
    $firstSignalContent = Get-Content -LiteralPath $signalPath -Raw -Encoding UTF8

    $duplicateResult = Invoke-Handler (New-IssueEvent -Number 700 -Title 'POSTMAN REQ_PROBE_001' -Body $readyBody)
    Assert-True ($duplicateResult.ExitCode -eq 0) 'identical event rerun exits successfully'
    Assert-True ($duplicateResult.Output -like '*SIGNAL_DUPLICATE*') 'identical event is suppressed'
    Assert-True (@(Get-ChildItem -LiteralPath $signalDirectory -Filter '*.json').Count -eq 1) 'duplicate does not create another signal file'
    Assert-True ((Get-Content -LiteralPath $signalPath -Raw -Encoding UTF8) -ceq $firstSignalContent) 'duplicate does not rewrite logical result'

    $waitingBody = "request_id: REQ_WAITING_001`nstatus: WAITING`nprotocol_version: 1`n`nstatus: READY appears only in response text"
    $waitingResult = Invoke-Handler (New-IssueEvent -Number 701 -Title 'POSTMAN REQ_WAITING_001' -Body $waitingBody)
    Assert-True ($waitingResult.ExitCode -eq 0) 'WAITING event exits successfully'
    Assert-True ($waitingResult.Output -like '*IGNORED status=WAITING*') 'WAITING event is ignored'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $signalDirectory 'REQ_WAITING_001.json'))) 'WAITING creates no signal'

    $unrelatedBody = "request_id: REQ_UNRELATED_001`nstatus: READY`nprotocol_version: 1`n`nunrelated response"
    $unrelatedEvent = New-IssueEvent -Number 702 -Title 'Ordinary issue' -Body $unrelatedBody
    $unrelatedResult = Invoke-Handler $unrelatedEvent
    Assert-True ($unrelatedResult.ExitCode -eq 0) 'unrelated issue exits successfully'
    Assert-True ($unrelatedResult.Output -like '*IGNORED title*') 'unrelated issue is ignored'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $signalDirectory 'REQ_UNRELATED_001.json'))) 'unrelated issue creates no signal'

    $invalidIdBody = "request_id: REQ_BAD!`nstatus: READY`nprotocol_version: 1`n`ninvalid id"
    $invalidIdResult = Invoke-Handler (New-IssueEvent -Number 703 -Title 'POSTMAN REQ_INVALID_001' -Body $invalidIdBody)
    Assert-True ($invalidIdResult.ExitCode -ne 0) 'invalid request_id is rejected'
    Assert-True ($invalidIdResult.Output -like '*request_id does not match*') 'invalid request_id has a clear rejection'

    $malformedBody = "request_id: REQ_MALFORMED_001`nstatus: READY`nprotocol_version: 1`nNO BLANK LINE"
    $malformedResult = Invoke-Handler (New-IssueEvent -Number 704 -Title 'POSTMAN REQ_MALFORMED_001' -Body $malformedBody)
    Assert-True ($malformedResult.ExitCode -ne 0) 'malformed header is rejected'
    Assert-True ($malformedResult.Output -like '*blank line*') 'malformed header has a clear rejection'

    $falseReadyBody = "request_id: REQ_FALSE_READY_001`nstatus: WAITING`nprotocol_version: 1`n`nresponse says status: READY but header is WAITING"
    $falseReadyResult = Invoke-Handler (New-IssueEvent -Number 705 -Title 'POSTMAN REQ_FALSE_READY_001' -Body $falseReadyBody)
    Assert-True ($falseReadyResult.ExitCode -eq 0) 'false READY in response is not an error'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $signalDirectory 'REQ_FALSE_READY_001.json'))) 'false READY in response creates no signal'

    $pullRequestResult = Invoke-Handler (New-IssueEvent -Number 706 -Title 'POSTMAN REQ_PR_001' -Body $readyBody -PullRequest $true)
    Assert-True ($pullRequestResult.ExitCode -ne 0) 'pull request event is rejected'
    Assert-True ($pullRequestResult.Output -like '*Pull request events*') 'pull request rejection is explicit'

    $mismatchBody = "request_id: REQ_OTHER_001`nstatus: READY`nprotocol_version: 1`n`nmismatch"
    $mismatchResult = Invoke-Handler (New-IssueEvent -Number 707 -Title 'POSTMAN REQ_MISMATCH_001' -Body $mismatchBody)
    Assert-True ($mismatchResult.ExitCode -ne 0) 'title/body request mismatch is rejected'

    $lowercaseResult = Invoke-Handler (New-IssueEvent -Number 708 -Title 'postman REQ_LOWERCASE_001' -Body "request_id: REQ_LOWERCASE_001`nstatus: READY`nprotocol_version: 1`n`nlowercase title")
    Assert-True ($lowercaseResult.ExitCode -eq 0) 'lowercase title is safely ignored'
    Assert-True ($lowercaseResult.Output -like '*IGNORED title*') 'lowercase title is not accepted as protocol'

    $updatedBody = "request_id: REQ_PROBE_001`nstatus: READY`nprotocol_version: 1`n`nUPDATED RESPONSE"
    $updatedResult = Invoke-Handler (New-IssueEvent -Number 700 -Title 'POSTMAN REQ_PROBE_001' -Body $updatedBody -UpdatedAt '2026-08-27T20:01:00Z')
    Assert-True ($updatedResult.ExitCode -eq 0) 'new READY version exits successfully'
    $updatedSignalRaw = Get-Content -LiteralPath $signalPath -Raw -Encoding UTF8
    $updatedSignal = $updatedSignalRaw | ConvertFrom-Json
    Assert-True ($updatedSignal.response -ceq 'UPDATED RESPONSE') 'new body version updates the same durable locator'
    Assert-True ($updatedSignalRaw -match '"githubUpdatedAt"\s*:\s*"2026-08-27T20:01:00\.0000000Z"') 'updated_at is stored in canonical UTC form'
    Assert-True (@($updatedSignal.processedDeliveryKeys).Count -eq 2) 'signal retains both processed delivery keys'
    Assert-True (@(Get-ChildItem -LiteralPath $signalDirectory -Filter '*.json').Count -eq 1) 'same request keeps one durable locator'

    $oldEventResult = Invoke-Handler (New-IssueEvent -Number 700 -Title 'POSTMAN REQ_PROBE_001' -Body $readyBody)
    Assert-True ($oldEventResult.ExitCode -eq 0) 'previous READY event remains safe to replay'
    Assert-True ($oldEventResult.Output -like '*SIGNAL_DUPLICATE*') 'previous delivery key is suppressed after a newer result'
    $afterOldReplay = Get-Content -LiteralPath $signalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($afterOldReplay.response -ceq 'UPDATED RESPONSE') 'replaying an old event does not roll back the signal'

    Write-Output "POSTMAN_WAKEUP_TESTS_PASS passed=$passed"
}
finally {
    if ($null -eq $oldLocalAppData) {
        Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
    }
    else {
        $env:LOCALAPPDATA = $oldLocalAppData
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
