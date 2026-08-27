[CmdletBinding()]
param(
    [ValidateSet('CopyRegression','CopyOneLine','CopyTwoLines','CopyRepeated','CopyMarkdown','CopyLong','CopyOldAssistantProtection','SubmitGateFailure','QuickSmoke','QuickStress','FreshChatRegression','InputRecoveryValuePattern','InputRecoveryClipboardFailure')][string]$Suite = 'CopyRegression',
    [ValidateRange(1,20)][int]$Count = 3,
    [ValidateSet('Fresh','Current')][string]$ChatPolicy = 'Fresh',
    [ValidateRange(5,120)][int]$TimeoutSeconds = 120,
    [string]$OutputPath,
    [string]$GitCommit
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$startedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
$run = [guid]::NewGuid().ToString('N').Substring(0,8).ToUpperInvariant()
$timeout = [Math]::Min(120, [Math]::Max(5, $TimeoutSeconds))
$logDir = Join-Path $root 'logs'
$diagDir = Join-Path $root 'diagnostics'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $diagDir -Force | Out-Null
$scriptPath = Join-Path $root 'chatgpt_chat.ps1'
$rows = New-Object 'System.Collections.Generic.List[object]'
$setupRows = New-Object 'System.Collections.Generic.List[object]'

function Normalize([string]$Text) {
    if ($null -eq $Text) { return $null }
    return (($Text -replace "`r`n", "`n") -replace "`r", "`n").TrimEnd("`n")
}
function Get-Hash([string]$Text) {
    if ($null -eq $Text) { return $null }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha.Dispose() }
}

$script:CodeFiles = [ordered]@{
    'chatgpt_chat.ps1' = Join-Path $root 'chatgpt_chat.ps1'
    'chatgpt_bridge_test.ps1' = Join-Path $root 'chatgpt_bridge_test.ps1'
    'chatgpt_uia_dump.ps1' = Join-Path $root 'chatgpt_uia_dump.ps1'
}
function Get-CodeHashes {
    $hashes = [ordered]@{}
    foreach ($name in $script:CodeFiles.Keys) {
        $path = $script:CodeFiles[$name]
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "CODE_HASH_FILE_MISSING|$name|7" }
        $hashes[$name] = ([string](Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash).ToLowerInvariant()
    }
    return $hashes
}
function Get-GitMetadata {
    $metadata = [ordered]@{ gitCommit=$null; workingTreeDirty=$null }
    $saved = @{}
    foreach ($name in @('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        # Do not report the surrounding harness repository as the bridge commit
        # unless all three bridge files are tracked in that same repository.
        foreach ($name in $saved.Keys) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue }
        $tracked = @(& git -C $root ls-files --error-unmatch -- @($script:CodeFiles.Keys) 2>$null)
        if (($LASTEXITCODE -eq 0) -and ($tracked.Count -eq $script:CodeFiles.Count)) {
            $commit = @(& git -C $root rev-parse HEAD 2>$null | Select-Object -First 1)
            if ($commit.Count -gt 0) { $metadata.gitCommit = ([string]$commit[0]).Trim() }
            $status = @(& git -C $root status --porcelain -- @($script:CodeFiles.Keys) 2>$null)
            $metadata.workingTreeDirty = ($status.Count -gt 0)
        }
    } catch { }
    finally {
        foreach ($name in $saved.Keys) {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue }
            else { Set-Item -LiteralPath ("Env:" + $name) -Value $saved[$name] }
        }
    }
    return [pscustomobject]$metadata
}
function Get-JsonPropertyValue($Object, [string]$Name) {
    if (!$Object) { return $null }
    $property = $Object.PSObject.Properties | Where-Object Name -eq $Name | Select-Object -First 1
    if ($property) { return $property.Value }
    return $null
}
function Assert-HashBinding($ResultJson, $CurrentHashes, [string]$Context) {
    if (!$ResultJson -or !$ResultJson.codeHashes) {
        throw "${Context}_STALE|Result has no codeHashes binding|7"
    }
    $properties = @($ResultJson.codeHashes.PSObject.Properties)
    $expectedNames = @($CurrentHashes.Keys)
    $actualNames = @($properties | Select-Object -ExpandProperty Name)
    if ($actualNames.Count -ne $expectedNames.Count -or
        @($actualNames | Where-Object { $_ -notin $expectedNames }).Count -gt 0 -or
        @($expectedNames | Where-Object { $_ -notin $actualNames }).Count -gt 0) {
        throw "${Context}_STALE|codeHashes must contain exactly the three bridge files|7"
    }
    foreach ($name in $expectedNames) {
        $savedHash = [string](Get-JsonPropertyValue $ResultJson.codeHashes $name)
        if ($savedHash -notmatch '^[0-9a-fA-F]{64}$' -or
            $savedHash.ToLowerInvariant() -ne ([string]$CurrentHashes[$name]).ToLowerInvariant()) {
            throw "${Context}_STALE|code hash mismatch for $name|7"
        }
    }
}
function Find-LatestResult([string]$Filter) {
    return Get-ChildItem -LiteralPath $root -Filter $Filter -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
function Read-Result([System.IO.FileInfo]$File, [string]$ErrorCode) {
    if (!$File) { throw "${ErrorCode}_REQUIRED|Required result file was not found|7" }
    try { return Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "${ErrorCode}_REQUIRED|Result file is invalid JSON: $($File.Name)|7" }
}
function Write-Result($Result, [string]$Destination) {
    $json = $Result | ConvertTo-Json -Depth 12
    # Round-trip parsing detects truncated or malformed serialized metadata.
    try { $null = $json | ConvertFrom-Json }
    catch { throw "RESULT_WRITE_FAILED|Result metadata could not be serialized as JSON|7" }
    $temporary = "$Destination.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        Set-Content -LiteralPath $temporary -Value $json -Encoding UTF8
        $null = Get-Content -LiteralPath $temporary -Raw -Encoding UTF8 | ConvertFrom-Json
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        throw "RESULT_WRITE_FAILED|Could not atomically write valid JSON result|7"
    }
}
function Invoke-Bridge([string]$PromptText, [string]$Id, [ValidateSet('Fresh','Current')][string]$Policy = $ChatPolicy) {
    $log = Join-Path $logDir "test_${Id}.log"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $parameters = @{ Mode='Quick'; ChatPolicy=$Policy; Prompt=$PromptText; RunId=$Id; LogPath=$log; ReturnJson=$true; TimeoutSeconds=$timeout }
    if ($PromptText.StartsWith('FAILED_SUBMIT_')) { $parameters.TestSubmitGateFailure = $true }
    if ($Suite -eq 'InputRecoveryValuePattern') { $parameters.TestForceValuePatternFailure = $true }
    if ($Suite -eq 'InputRecoveryClipboardFailure') {
        $parameters.TestForceValuePatternFailure = $true
        $parameters.TestForceClipboardFallbackFailure = $true
    }
    $output = & $scriptPath @parameters 2>&1
    $watch.Stop()
    return [pscustomobject]@{ Output=@($output); ElapsedMs=$watch.ElapsedMilliseconds; LogPath=$log }
}
function Parse-Bridge($Invocation) {
    try {
        $lines = @($Invocation.Output | ForEach-Object { [string]$_ } | Where-Object { ![string]::IsNullOrWhiteSpace($_) })
        if ($lines.Count -ne 1) { throw "Expected exactly one JSON output line, got $($lines.Count)" }
        $raw = $lines[0]
        return [pscustomobject]@{ Json=($raw | ConvertFrom-Json); RawLength=$raw.Length; ParseError=$null }
    } catch {
        return [pscustomobject]@{ Json=$null; RawLength=0; ParseError=$_.Exception.Message }
    }
}
function Add-Case([string]$Name, [string]$PromptText, [string]$Expected, [bool]$SubmitFailure, [string]$OldMarker, [switch]$Setup, [ValidateSet('Fresh','Current')][string]$Policy = $ChatPolicy, [string[]]$ExpectedErrorCodes, [switch]$RequireOldMarker) {
    $id = "${run}_$Name"
    $invocation = Invoke-Bridge $PromptText $id $Policy
    $parsed = Parse-Bridge $invocation
    $json = $parsed.Json
    $actual = if ($json -and $null -ne $json.response) { Normalize ([string]$json.response) } else { $null }
    $expectedNormalized = Normalize $Expected
    $expectedHash = Get-Hash $expectedNormalized
    $actualHash = Get-Hash $actual
    $errorCode = if ($json -and $json.error) { [string]$json.error.code } elseif ($parsed.ParseError) { 'INVALID_JSON' } else { $null }
    $copyTrace = Join-Path $diagDir "copy_trace_${id}.jsonl"
    $streamTrace = Join-Path $diagDir "stream_trace_${id}.jsonl"
    $assistantTrace = Join-Path $diagDir "assistant_extract_${id}.jsonl"
    $uiTracePresent = Test-Path $copyTrace
    $traceConfirmed = $false
    $traceCompact = $false
    $traceRowCount = 0
    if ($uiTracePresent) {
        try {
            $traceRows = @(Get-Content -LiteralPath $copyTrace -Encoding UTF8 -ErrorAction Stop | Where-Object { ![string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ | ConvertFrom-Json })
            $traceRowCount = $traceRows.Count
            $traceConfirmed = @($traceRows | Where-Object { $_.Confirmed -eq $true -and $_.CopyRuntimeId }).Count -eq 1
            $traceCompact = ($traceRowCount -eq 1 -and $traceConfirmed)
        } catch { $traceConfirmed = $false; $traceCompact = $false }
    }
    $cleanActual = ($null -ne $actual -and
        !$actual.Contains('Сообщение ChatGPT') -and !$actual.Contains('ChatGPT сказал') -and
        !$actual.Contains('Копировать') -and !$actual.Contains('Хороший ответ') -and
        !$actual.Contains('Неудачный ответ'))
    $policyOk = ($json -and ([string]$json.chatPolicy -ceq $Policy.ToLowerInvariant()))
    $freshOk = if ($Policy -eq 'Fresh') { $json -and [bool]$json.freshChatConfirmed -and $json.freshMessageCount -eq 0 } else { $true }
    $positive = ((-not $SubmitFailure) -and ($null -ne $json) -and [bool]$json.ok -and ($null -ne $json.response) -and
        [bool]$policyOk -and [bool]$freshOk -and ([string]$actual -ceq [string]$expectedNormalized) -and
        ([string]$expectedHash -ceq [string]$actualHash) -and [bool]$cleanActual -and [bool]$traceCompact)
    $freshSafeRefusal = ($Name -eq 'FreshChatRegression' -and $json -and !$json.ok -and $null -eq $json.response -and
        $policyOk -and $json.baselineMessageCount -eq 0 -and $errorCode -eq 'FRESH_CHAT_NOT_CONFIRMED')
    $negative = (($SubmitFailure -or $ExpectedErrorCodes) -and $json -and !$json.ok -and $null -eq $json.response -and
        ((!$ExpectedErrorCodes -and $errorCode -in @('SUBMIT_NOT_CONFIRMED','INPUT_NOT_CONFIRMED','USER_MESSAGE_NOT_CONFIRMED')) -or
         ($ExpectedErrorCodes -and $errorCode -in $ExpectedErrorCodes)))
    $oldAbsent = ($null -eq $OldMarker -or $OldMarker.Length -eq 0 -or $null -eq $actual -or !$actual.Contains($OldMarker))
    $oldPresent = ($null -ne $OldMarker -and $OldMarker.Length -gt 0 -and $null -ne $actual -and $actual.Contains($OldMarker))
    $passed = if ($SubmitFailure -or $ExpectedErrorCodes) { $negative } elseif ($freshSafeRefusal) { $true } elseif ($RequireOldMarker) { $positive -and $oldPresent } else { $positive -and $oldAbsent }
    $row = [ordered]@{
        name=$Name; runId=$id; result=if($passed){'PASS'}else{'FAIL'}
        expected=$expectedNormalized; actual=$actual
        error=if($passed){$null}elseif($errorCode){$errorCode}else{'MISMATCH'}
        expectedLength=if($null -eq $expectedNormalized){0}else{$expectedNormalized.Length}; actualLength=if($null -eq $actual){0}else{$actual.Length}
        expectedHash=$expectedHash; actualHash=$actualHash; responseIsNull=($null -eq $actual)
        chatPolicy=if($json){$json.chatPolicy}else{$null}; freshChatConfirmed=if($json){$json.freshChatConfirmed}else{$null}; freshMessageCount=if($json){$json.freshMessageCount}else{$null}; baselineMessageCount=if($json){$json.baselineMessageCount}else{$null}
        inputMethod=if($json){$json.inputMethod}else{$null}; inputAttemptCount=if($json){$json.inputAttemptCount}else{$null}; clipboardRestored=if($json){$json.clipboardRestored}else{$null}
        copyRuntimeId=if($json){$json.copyRuntimeId}else{$null}; copyTracePath=if($uiTracePresent){$copyTrace}else{$null}
        streamTracePath=if(Test-Path $streamTrace){$streamTrace}else{$null}
        assistantTracePath=if(Test-Path $assistantTrace){$assistantTrace}else{$null}; logPath=$invocation.LogPath
        durationMs=if($json){$json.durationMs}else{$invocation.ElapsedMs}; oldMarkerAbsent=$oldAbsent; oldMarkerPresent=$oldPresent; traceRowCount=$traceRowCount; traceCompact=$traceCompact; errorCode=$errorCode
    }
    if ($Setup) { [void]$setupRows.Add([pscustomobject]$row) } else { [void]$rows.Add([pscustomobject]$row) }
}

$required = @('CopyOneLine','CopyTwoLines','CopyRepeated','CopyMarkdown','CopyLong','CopyOldAssistantProtection','SubmitGateFailure')
$codeHashes = Get-CodeHashes
$gitMetadata = Get-GitMetadata
$gateJson = $null
if ($Suite -in @('QuickSmoke','QuickStress')) {
    $gateFile = Find-LatestResult 'CopyRegression_*_results.json'
    $gateJson = Read-Result $gateFile 'COPY_REGRESSION_GATE'
    if ($gateJson.suite -ne 'CopyRegression') {
        throw 'COPY_REGRESSION_GATE_REQUIRED|Latest result is not a CopyRegression suite|7'
    }
    Assert-HashBinding $gateJson $codeHashes 'COPY_REGRESSION_GATE'
    $gateNames = @($gateJson.attempts | Where-Object { $_.name -in $required } | Select-Object -ExpandProperty name -Unique)
    $gateRowsValid = @($gateJson.attempts | Where-Object {
        $_.name -in $required -and $_.result -ceq 'PASS' -and $_.expectedHash -and $_.actualHash -and $_.expectedHash -ceq $_.actualHash
    }).Count -eq 7
    if (!$gateJson.summary -or $gateJson.summary.total -ne 7 -or $gateJson.summary.failed -ne 0 -or
        $gateJson.summary.passed -ne 7 -or $gateNames.Count -ne 7 -or !$gateRowsValid) {
        throw 'COPY_REGRESSION_GATE_REQUIRED|Latest CopyRegression is not a complete 7-case pass|7'
    }
}
if ($Suite -eq 'QuickStress') {
    $smokeFile = Find-LatestResult 'QuickSmoke_*_results.json'
    $smokeJson = Read-Result $smokeFile 'QUICKSMOKE_GATE'
    if ($smokeJson.suite -ne 'QuickSmoke') {
        throw 'QUICKSMOKE_GATE_REQUIRED|Latest result is not a QuickSmoke suite|7'
    }
    Assert-HashBinding $smokeJson $codeHashes 'QUICKSMOKE_GATE'
    $smokeNames = @($smokeJson.attempts | Where-Object { $_.name -match '^Q\d{2}$' } | Select-Object -ExpandProperty name -Unique)
    $smokeRowsValid = @($smokeJson.attempts | Where-Object {
        $_.name -match '^Q\d{2}$' -and $_.result -eq 'PASS' -and $_.expectedHash -and $_.actualHash -and $_.expectedHash -ceq $_.actualHash
    }).Count -eq 5
    if (!$smokeJson.summary -or $smokeJson.summary.total -ne 5 -or $smokeJson.summary.failed -ne 0 -or
        $smokeJson.summary.passed -ne 5 -or $smokeNames.Count -ne 5 -or !$smokeRowsValid) {
        throw 'QUICKSMOKE_GATE_REQUIRED|QuickSmoke is not a complete 5-case pass; QuickStress is blocked|7'
    }
}

$caseNames = New-Object 'System.Collections.Generic.List[string]'
if ($Suite -eq 'CopyRegression') {
    foreach ($name in $required) { [void]$caseNames.Add($name) }
} elseif ($Suite -eq 'QuickSmoke') {
    foreach ($i in 1..5) { [void]$caseNames.Add(('Q{0:D2}' -f $i)) }
} elseif ($Suite -eq 'QuickStress') {
    foreach ($i in 1..20) { [void]$caseNames.Add(('Q{0:D2}' -f $i)) }
} else { [void]$caseNames.Add($Suite) }

foreach ($name in $caseNames) {
    $expected = $null; $prompt = $null; $old = $null
    $policy = $ChatPolicy
    $expectedErrors = $null
    $isSubmitFailure = ($name -eq 'SubmitGateFailure')
    switch ($name) {
        'CopyOneLine' { $expected="ONE_$run"; $prompt="Ответь только: $expected"; break }
        'CopyTwoLines' { $expected="LINE1_$run`nLINE2_$run"; $prompt="Ответь ровно двумя строками:`nLINE1_$run`nLINE2_$run"; break }
        'CopyRepeated' { $expected="SAME_$run`nSAME_$run`nSAME_$run"; $prompt="Ответь ровно тремя строками:`nSAME_$run`nSAME_$run`nSAME_$run"; break }
        'CopyMarkdown' { $expected="# TITLE_$run`n- ONE`n- TWO`nCODE_$run"; $prompt="Ответь только этим текстом, без пояснений, кавычек и обратных кавычек. Ровно четыре строки:`n# TITLE_$run`n- ONE`n- TWO`nCODE_$run"; break }
        'CopyLong' { $expected="LONG_$run`nЭто длинная проверочная строка.`nЕще одна строка для проверки полного буфера.`nEND_$run"; $prompt="Ответь ровно четырьмя строками:`nLONG_$run`nЭто длинная проверочная строка.`nЕще одна строка для проверки полного буфера.`nEND_$run"; break }
        'CopyOldAssistantProtection' { $old="OLD_REPLY_$run"; $expected="NEW_REPLY_$run"; $prompt="Ответь только: $expected"; $policy='Current'; break }
        'SubmitGateFailure' { $prompt="FAILED_SUBMIT_$run`nDo not send this"; break }
        'FreshChatRegression' { $expected="FRESH_$run"; $prompt="Ответь только: $expected"; $policy='Fresh'; break }
        'InputRecoveryValuePattern' { $expected="VALUE_$run"; $prompt="Ответь только: $expected"; $policy='Fresh'; $expectedErrors=@('INPUT_NOT_CONFIRMED','FRESH_CHAT_NOT_CONFIRMED'); break }
        'InputRecoveryClipboardFailure' { $prompt="CLIPBOARD_FAILURE_$run"; $policy='Fresh'; $expectedErrors=@('INPUT_NOT_CONFIRMED'); break }
        default {
            # Quick cases deliberately use a run-scoped exact nonce.  The visible
            # label and expected response are both Q01_<RunId>, never a reusable Q1.
            if ($Suite -in @('QuickSmoke','QuickStress') -and $name -match '^Q\d{2}$') {
                $expected = "${name}_$run"
            } else {
                $expected = $name
            }
            $prompt = "Ответь только: $expected"
            break
        }
    }
    if ($name -eq 'CopyOldAssistantProtection') {
        Add-Case 'CopyOldAssistantProtection_Preflight' "Ответь только: $old" $old $false $old -Setup -Policy 'Current' -RequireOldMarker
    }
    Add-Case $name $prompt $expected $isSubmitFailure $old -Policy $policy -ExpectedErrorCodes $expectedErrors
    # A failure is a terminal result for Quick suites.  Do not continue to a
    # later attempt and accidentally turn a partial run into a passing gate.
    if ($Suite -in @('QuickSmoke','QuickStress') -and $rows[$rows.Count - 1].result -eq 'FAIL') { break }
}

$quickContractError = $null
$expectedQuickTotal = $null
if ($Suite -in @('QuickSmoke','QuickStress')) {
    $expectedQuickTotal = if ($Suite -eq 'QuickSmoke') { 5 } else { 20 }
    $quickRows = @($rows.ToArray())
    $quickNames = @($quickRows | Select-Object -ExpandProperty name)
    $quickExpected = @($quickRows | Select-Object -ExpandProperty expected)
    $quickContractOk = ($quickRows.Count -le $expectedQuickTotal -and
        $quickNames.Count -eq @($quickNames | Select-Object -Unique).Count -and
        $quickExpected.Count -eq @($quickExpected | Select-Object -Unique).Count)
    foreach ($row in $quickRows) {
        if ($row.name -notmatch '^Q\d{2}$' -or $row.expected -ne "$($row.name)_$run") { $quickContractOk = $false }
    }
    if (!$quickContractOk) {
        $quickContractError = 'QUICK_NONCE_CONTRACT_FAILED'
    }
}

$gitMetadata = Get-GitMetadata
if ($GitCommit -and $GitCommit -match '^[0-9a-fA-F]{40}$') { $gitMetadata.gitCommit = $GitCommit.ToLowerInvariant() }
$expectedTotal = if ($null -ne $expectedQuickTotal) { $expectedQuickTotal } elseif ($Suite -eq 'CopyRegression') { 7 } else { $rows.Count }
$passedCount = @($rows | Where-Object result -eq PASS).Count
$failedCount = @($rows | Where-Object result -eq FAIL).Count
$result = [ordered]@{
    schemaVersion=5; suite=$Suite; runId=$run; startedAtUtc=$startedAtUtc; completedAtUtc=(Get-Date).ToUniversalTime().ToString('o')
    timeoutSeconds=$timeout; codeHashes=$codeHashes; gitCommit=$gitMetadata.gitCommit; workingTreeDirty=$gitMetadata.workingTreeDirty
    metadata=[ordered]@{ codeFiles=@($script:CodeFiles.Keys); normalization='CRLF/CR to LF; trim terminal LF only'; exactMatch=$true; attempted=$rows.Count; unattempted=($expectedTotal - $rows.Count); stoppedOnFailure=($rows.Count -gt 0 -and $rows[$rows.Count - 1].result -eq 'FAIL'); contractError=$quickContractError }
    summary=[ordered]@{ total=$expectedTotal; passed=$passedCount; failed=$failedCount }
    attempts=@($rows.ToArray()); setupAttempts=@($setupRows.ToArray())
}
$destination = if ($OutputPath) { $OutputPath } else { Join-Path $root "${Suite}_${run}_results.json" }
Write-Result $result $destination
Write-Output ($result | ConvertTo-Json -Compress -Depth 12)
if ($result.summary.failed -or ($result.summary.total -ne $result.summary.passed) -or $quickContractError) { exit 1 }
else { exit 0 }
