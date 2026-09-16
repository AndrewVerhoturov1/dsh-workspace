$ErrorActionPreference = 'Stop'
$reportPath = 'D:\BootRecovery\V2P-Migration\DiskPart-safe-diagnostic-20260914.txt'
$result = New-Object System.Collections.Generic.List[string]
try {
    $result.Add(('USER=' + [Security.Principal.WindowsIdentity]::GetCurrent().Name))
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $result.Add(('ELEVATED=' + $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))
    $diskpartPath = 'C:\Windows\System32\diskpart.exe'
    $target = @(Get-Disk | Where-Object { $_.Number -eq 4 })
    $result.Add(('TARGET_COUNT=' + $target.Count))
    foreach ($d in $target) {
        $result.Add(('TARGET Number={0};FriendlyName=[{1}];Trim=[{2}];Serial=[{3}];Size={4};Bus={5};Boot={6};System={7};Offline={8};ReadOnly={9};Style={10};Partitions={11}' -f $d.Number, $d.FriendlyName, ([string]$d.FriendlyName).Trim(), $d.SerialNumber, $d.Size, $d.BusType, $d.IsBoot, $d.IsSystem, $d.IsOffline, $d.IsReadOnly, $d.PartitionStyle, $d.NumberOfPartitions))
    }
    $exact = @($target | Where-Object {
        ([string]$_.FriendlyName).Trim() -ceq 'USB DISK 2.0' -and
        ([string]$_.SerialNumber) -ceq '027704A09010' -and
        ([Int64]$_.Size) -eq [Int64]31016878080 -and
        ([string]$_.BusType) -ceq 'USB' -and
        $_.IsBoot -eq $false -and $_.IsSystem -eq $false -and
        $_.IsOffline -eq $false -and $_.IsReadOnly -eq $false
    })
    $result.Add(('EXACT_COUNT=' + $exact.Count))
    if ($exact.Count -ne 1) { throw 'Exact USB precheck failed' }
    $c = @(Get-CimInstance Win32_DiskDrive | Where-Object Index -eq 4)
    $result.Add(('CIM_COUNT=' + $c.Count))
    foreach ($x in $c) {
        $result.Add(('CIM Index={0};Model=[{1}];Serial=[{2}];Size={3};DeviceID=[{4}]' -f $x.Index, $x.Model, $x.SerialNumber, $x.Size, $x.DeviceID))
    }
    if ($c.Count -ne 1 -or ([string]$c[0].SerialNumber) -cne '027704A09010') { throw 'CIM precheck failed' }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('Prepare-Win10-Legacy-USB-safe-' + ([Guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $temp = Join-Path $work 'script.txt'
    $out = Join-Path $work 'stdout.txt'
    $err = Join-Path $work 'stderr.txt'
    $targetNumber = [int]$exact[0].Number
    $productionLines = @('select disk ' + $targetNumber, 'clean', 'convert mbr', 'exit')
    $result.Add(('PRODUCTION_EXPR_COUNT=' + $productionLines.Count))
    for ($i = 0; $i -lt $productionLines.Count; $i++) {
        $pb = [Text.Encoding]::ASCII.GetBytes($productionLines[$i])
        $result.Add(('PRODUCTION_LINE{0}_VALUE=[{1}];LENGTH={2};HEX={3}' -f $i, $productionLines[$i], $productionLines[$i].Length, (($pb | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    }
    $lines = @('list disk', ('select disk ' + $targetNumber), 'detail disk', 'exit')
    [IO.File]::WriteAllLines($temp, $lines, [Text.Encoding]::ASCII)
    $copy = 'D:\BootRecovery\V2P-Migration\DiskPart-safe-diagnostic-script-20260914.txt'
    Copy-Item -LiteralPath $temp -Destination $copy -Force
    $raw = [IO.File]::ReadAllBytes($temp)
    $asc = [Text.Encoding]::ASCII.GetString($raw)
    $result.Add(('SCRIPT_TEMP=' + $temp))
    $result.Add(('SCRIPT_COPY=' + $copy))
    $result.Add(('SCRIPT_LENGTH=' + $raw.Length))
    $result.Add(('SCRIPT_HEX=' + (($raw | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    $result.Add(('SCRIPT_CRLF=' + ([regex]::Matches($asc, "`r`n")).Count))
    $result.Add(('SCRIPT_LF_ONLY=' + ([regex]::Matches($asc, "(?<!`r)`n")).Count))
    $result.Add(('SCRIPT_CR_ONLY=' + ([regex]::Matches($asc, "(?<!`n)`r")).Count))
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $lb = [Text.Encoding]::ASCII.GetBytes($lines[$i])
        $result.Add(('LINE{0}_VALUE=[{1}];LENGTH={2};HEX={3}' -f $i, $lines[$i], $lines[$i].Length, (($lb | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    }
    $args = @('/s', $temp)
    $result.Add(('START_FILE=' + $diskpartPath))
    $result.Add(('START_ARGUMENT_0=[' + $args[0] + '];START_ARGUMENT_1=[' + $args[1] + ']'))
    $result.Add(('START_CONSTRUCTED=/s ' + $temp))
    $result.Add(('START_QUOTED="/s" "' + $temp + '"'))
    $p = Start-Process -FilePath $diskpartPath -ArgumentList $args -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
    $oraw = [IO.File]::ReadAllBytes($out)
    $eraw = [IO.File]::ReadAllBytes($err)
    $result.Add(('START_EXIT=' + $p.ExitCode))
    $result.Add(('START_STDOUT_LENGTH=' + $oraw.Length))
    $result.Add(('START_STDERR_LENGTH=' + $eraw.Length))
    $result.Add(('START_STDOUT_HEX=' + (($oraw | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    $result.Add(('START_STDERR_HEX=' + (($eraw | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    $result.Add('START_STDOUT_DEFAULT_BEGIN')
    foreach ($line in ([Text.Encoding]::Default.GetString($oraw) -split "`r?`n") ) { $result.Add($line) }
    $result.Add('START_STDOUT_END')
    $result.Add('START_STDERR_DEFAULT_BEGIN')
    foreach ($line in ([Text.Encoding]::Default.GetString($eraw) -split "`r?`n") ) { $result.Add($line) }
    $result.Add('START_STDERR_END')
    $direct = Join-Path $work 'direct-script.txt'
    $directOut = Join-Path $work 'direct-stdout.txt'
    $directErr = Join-Path $work 'direct-stderr.txt'
    [IO.File]::WriteAllLines($direct, $lines, [Text.Encoding]::ASCII)
    $directArgs = @('/s', $direct)
    $result.Add(('DIRECT_FILE=' + $diskpartPath))
    $result.Add(('DIRECT_ARGUMENT_0=[' + $directArgs[0] + '];DIRECT_ARGUMENT_1=[' + $directArgs[1] + ']'))
    $result.Add(('DIRECT_CONSTRUCTED=/s ' + $direct))
    & $diskpartPath @directArgs 1> $directOut 2> $directErr
    $directCode = $LASTEXITCODE
    $doraw = [IO.File]::ReadAllBytes($directOut)
    $deraw = [IO.File]::ReadAllBytes($directErr)
    $result.Add(('DIRECT_EXIT=' + $directCode))
    $result.Add(('DIRECT_STDOUT_LENGTH=' + $doraw.Length))
    $result.Add(('DIRECT_STDERR_LENGTH=' + $deraw.Length))
    $result.Add(('DIRECT_STDOUT_HEX=' + (($doraw | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    $result.Add(('DIRECT_STDERR_HEX=' + (($deraw | ForEach-Object { $_.ToString('X2') }) -join ' ')))
    $result.Add(('DIRECT_STDOUT_DEFAULT=' + [Text.Encoding]::Default.GetString($doraw)))
    $result.Add(('DIRECT_STDERR_DEFAULT=' + [Text.Encoding]::Default.GetString($deraw)))
    $post = Get-Disk | Where-Object Number -eq 4
    $result.Add(('POST Number={0};Style={1};Partitions={2};Size={3};Bus={4};Friendly=[{5}];Serial=[{6}]' -f $post.Number, $post.PartitionStyle, $post.NumberOfPartitions, $post.Size, $post.BusType, $post.FriendlyName, $post.SerialNumber))
    $result.Add(('WORK=' + $work))
    $result.Add('STATUS=PASS')
} catch {
    $result.Add(('ERROR_TYPE=' + $_.Exception.GetType().FullName))
    $result.Add(('ERROR=' + $_.Exception.Message))
    $result.Add('STATUS=ERROR')
}
[IO.File]::WriteAllLines($reportPath, $result, [Text.Encoding]::UTF8)
