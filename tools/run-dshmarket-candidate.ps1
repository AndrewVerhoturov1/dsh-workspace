$cand = 'D:\DSH-dshmarket-candidate-20260911'
$log = Join-Path $cand 'runtime'
New-Item -ItemType Directory -Force $log | Out-Null
$env:DSH_HOME = $cand
$env:DSH_TELEMETRY_MODE = 'DISABLED'
$p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @('--expose-internals','C:\Users\Andrew\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js','--profile','web','--host','127.0.0.1','--port','4174','--no-open') -WorkingDirectory (Join-Path $cand 'profiles\web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'out.log') -RedirectStandardError (Join-Path $log 'err.log') -PassThru
Set-Content (Join-Path $log 'pid.txt') $p.Id
Start-Sleep -Seconds 8
$c = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -eq 4174}
if($c){$c | Select-Object LocalAddress,LocalPort,OwningProcess; try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://127.0.0.1:4174/').StatusCode}catch{$_.Exception.Message}} else {'NO_LISTENER'}
Get-Content (Join-Path $log 'err.log') -Tail 30 -Encoding UTF8
