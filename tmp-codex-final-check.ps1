$ErrorActionPreference = 'Stop'
$candidateRoot = 'D:\DSH-codex-final-candidate-v2-20260911'
$logRoot = Join-Path $candidateRoot 'candidate-4176'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$stdout = Join-Path $logRoot 'stdout.log'
$stderr = Join-Path $logRoot 'stderr.log'
Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
$env:PATH = 'C:\Program Files\nodejs;C:\Users\Andrew\AppData\Roaming\npm;' + $env:PATH
$env:DSH_HOME = $candidateRoot
$env:DSH_TELEMETRY_DISABLED = '1'
$env:DSH_PERMISSION_MODE = 'read-only'
foreach ($secretName in @('DEEPSEEK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','POSTMAN_API_KEY')) {
  Remove-Item -LiteralPath ('Env:' + $secretName) -ErrorAction SilentlyContinue
}
$node = 'C:\Program Files\nodejs\node.exe'
$entry = 'C:\Users\Andrew\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$profilePath = Join-Path $candidateRoot 'profiles\web'
$proc = Start-Process -FilePath $node -ArgumentList @($entry,'--profile','web','--host','127.0.0.1','--port','4176','--no-open') -WorkingDirectory $profilePath -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Write-Output "PID=$($proc.Id)"
Start-Sleep -Seconds 6
Write-Output "PID_ALIVE=$([bool](Get-Process -Id $proc.Id -ErrorAction SilentlyContinue))"
