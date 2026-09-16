$isoUrl = 'https://software.download.prss.microsoft.com/dbazure/Win10_22H2_Russian_x64v1.iso?t=68fadde6-a19f-4fff-b729-c48aece4dfc6&P1=1789400766&P2=602&P3=2&P4=U2Scnotz9aW9zUOeyJBdvZFjamRAEYupgwiuMRr7Yjou5rRbIi%2fP7YHFbV1%2fxYH2J0ZbJvUhx%2f%2bUaH0GLOD9iBQW%2bNsvYdQBiTcn9I3Smg%2bO9%2f9N%2bfUCTw0Y3W7K00QlU6R0FpZeiUPzthwLjV80laYFOc6HKbg9xKR1WuKqKvRzoQch96fl86xMy9QVL2pv7KJ%2ftOoM6U%2buUne9yFM4A0YdWzBjMRdkS9dFprWMju%2fMSCpYIsvLFvAPvjZor6wwEI4%2bXLX3uVoTQLWgssnv7P%2blLe0sP5K2UwSIHlRSkFtUtv1H0qYcUe2uQZP8hdxbhKzbKDzhB%2bMkaNrAMWwv6g%3d%3d'
$total = [int64]5835063296
$partCount = 8
$dest = 'C:\Users\Andrew\Downloads\Windows10_22H2_Russian_x64_full.iso'
$partDir = 'C:\Users\Andrew\Downloads\Win10ISO_parallel_20260913'
$uri = [Uri]$isoUrl
if ($uri.Host -ne 'software.download.prss.microsoft.com') { throw "Unexpected host $($uri.Host)" }
New-Item -ItemType Directory -Path $partDir -Force | Out-Null
$jobs = @()
for ($i = 0; $i -lt $partCount; $i++) {
    $start = [int64][math]::Floor($total * $i / $partCount)
    $end = [int64][math]::Floor($total * ($i + 1) / $partCount) - 1
    $part = Join-Path $partDir ('part{0:D2}.bin' -f ($i + 1))
    $jobs += Start-Job -ArgumentList $isoUrl, $start, $end, $part, $i -ScriptBlock {
        param($url, $s, $e, $p, $idx)
        & curl.exe --fail --location --retry 5 --retry-delay 3 --range ("$s-$e") --output $p $url
        if ($LASTEXITCODE -ne 0) { throw "segment $idx curl exit $LASTEXITCODE" }
        $actual = (Get-Item -LiteralPath $p).Length
        [pscustomobject]@{ Index = $idx; Start = $s; End = $e; Length = $actual; Path = $p }
    }
}
while (@($jobs | Where-Object State -in 'Running', 'NotStarted').Count -gt 0) {
    Start-Sleep -Seconds 30
    $done = @($jobs | Where-Object State -eq 'Completed').Count
    $failed = @($jobs | Where-Object State -eq 'Failed').Count
    $bytes = (Get-ChildItem -LiteralPath $partDir -Filter 'part??.bin' -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    "Progress: completed=$done/$partCount failed=$failed bytes=$bytes"
}
$results = @($jobs | Receive-Job)
$jobs | Remove-Job -Force
if ($results.Count -ne $partCount) { throw 'Not all segments completed' }
$parts = 1..$partCount | ForEach-Object { Join-Path $partDir ('part{0:D2}.bin' -f $_) }
$sum = [int64]0
foreach ($part in $parts) { $sum += (Get-Item -LiteralPath $part).Length }
if ($sum -ne $total) { throw "Segment size $sum differs from $total" }
$out = [System.IO.File]::Open($dest, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
    foreach ($part in $parts) {
        $input = [System.IO.File]::OpenRead($part)
        try { $input.CopyTo($out) } finally { $input.Dispose() }
    }
} finally { $out.Dispose() }
$finalLength = (Get-Item -LiteralPath $dest).Length
if ($finalLength -ne $total) { throw "Final size $finalLength differs from $total" }
Get-Item -LiteralPath $dest | Select-Object FullName, Length, LastWriteTime | Format-List
