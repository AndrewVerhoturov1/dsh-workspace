Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $PSScriptRoot 'switch-ptc-lab-junction.psm1'
$productionPluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('ptc-lab-e2e-fixture-' + [guid]::NewGuid().ToString('N'))
$oldTarget = Join-Path $fixtureRoot 'old-target'
$plugin = Join-Path $fixtureRoot 'task-plugin'
$dist = Join-Path $plugin 'dist-client'
$link = Join-Path $fixtureRoot 'profile\node_modules\dsh-postman-harness'
$fakeHost = Join-Path $fixtureRoot 'fake-host\lib\index.js'
$fakeBackup = Join-Path $fixtureRoot 'fake-host-backup.js'
$markerOld = Join-Path $oldTarget 'keep-old.txt'
$markerNew = Join-Path $plugin 'keep-task.txt'
$assets = @('assets/ptc-lab-browser-worker.mjs','emscripten-module.wasm')
New-Item -ItemType Directory -Path $oldTarget,$dist,(Join-Path $dist 'assets'),(Split-Path -Parent $link),(Split-Path -Parent $fakeHost) -Force | Out-Null
Set-Content -LiteralPath $markerOld -Value 'old preserved' -Encoding UTF8
Set-Content -LiteralPath $markerNew -Value 'task preserved' -Encoding UTF8
$package = @{name='dsh-postman-harness';exports=@{'./client'='./dist-client/client.js'}} | ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $plugin 'package.json') -Value $package -Encoding UTF8
Set-Content -LiteralPath (Join-Path $dist 'client.js') -Value 'bundle' -Encoding UTF8
foreach($asset in $assets){$path=Join-Path $dist $asset;New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force|Out-Null;Set-Content -LiteralPath $path -Value "fixture:$asset" -Encoding UTF8}
Set-Content -LiteralPath $fakeHost -Value 'patched-host' -Encoding UTF8
Set-Content -LiteralPath $fakeBackup -Value 'original-host' -Encoding UTF8
$configuration = @{
  ProfileJunction=$link; OriginalTarget=$oldTarget; TaskPlugin=$plugin
  HostFile=$fakeHost; HostBackup=$fakeBackup
  PatchedHostSha256=(Get-FileHash $fakeHost -Algorithm SHA256).Hash
  OriginalHostSha256=(Get-FileHash $fakeBackup -Algorithm SHA256).Hash
}
$module=$null
try {
  New-Item -ItemType Junction -Path $link -Target $oldTarget | Out-Null
  Import-Module -Name $modulePath -Force
  $module=Get-Module | Where-Object Path -eq (Resolve-Path $modulePath).Path | Select-Object -First 1
  if(-not $module){throw 'Fixture module import did not produce a module instance.'}

  $productionPayload = & $module {
    param($pluginRoot)
    $script:TaskPlugin = $pluginRoot
    $pinned = Assert-TaskPayload -PluginPath $pluginRoot
    [pscustomobject]@{ClientPath=$pinned.ClientPath;AssetRoot=$pinned.AssetRoot;Assets=@($script:AssetNames)}
  } $productionPluginRoot
  $builtFiles = @(Get-ChildItem -LiteralPath (Join-Path $productionPluginRoot 'dist-client') -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath((Join-Path $productionPluginRoot 'dist-client'), $_.FullName).Replace('\','/') } | Sort-Object)
  $expectedBuiltFiles = @('assets/ptc-lab-browser-worker.mjs','client.js','emscripten-module.wasm') | Sort-Object
  if(($builtFiles -join '|') -ne ($expectedBuiltFiles -join '|')) { throw "Production dist inventory mismatch: $($builtFiles -join ', ')" }
  if($productionPayload.Assets.Count -ne 2 -or -not(Test-Path -LiteralPath $productionPayload.ClientPath -PathType Leaf)) { throw 'Production TaskPlugin payload proof failed.' }

  $missingArguments = & $module {
    try { Invoke-LabInstall -Configuration @{}; throw 'Expected missing configuration STOP was not raised.' }
    catch { if($_.Exception.Message -notmatch 'explicit Lab configuration value') { throw }; $_.Exception.Message }
  }
  if($missingArguments -notmatch 'STOP: explicit Lab configuration value') { throw "Missing configuration gate failed: $missingArguments" }
  if(-not (Test-Path -LiteralPath $link) -or (Get-Item -LiteralPath $link -Force).Target -ne $oldTarget) { throw 'Missing-argument gate mutated fixture junction.' }

  $listenerMutationGate = & $module {
    param($configuration)
    $script:ListenerProbe={ @([pscustomobject]@{LocalPort=4173;State='Listen';OwningProcess=1234}) }
    $script:ProcessProbe={ @() }
    try { Invoke-LabInstall -Configuration $configuration; throw 'Expected listener STOP was not raised.' }
    catch { if($_.Exception.Message -notmatch 'port 4173 has listener') { throw }; $_.Exception.Message }
  } $configuration
  if($listenerMutationGate -notmatch 'STOP: port 4173 has listener' -or (Get-Item -LiteralPath $link -Force).Target -ne $oldTarget) { throw 'Listener gate failed or mutated fixture junction.' }

  $probeCases = & $module {
    $script:ProcessProbe={ @() }
    $script:ListenerProbe={ @() }
    Assert-NoHarnessListener
    $empty = 'PASS'
    $script:ListenerProbe={ @([pscustomobject]@{LocalPort=4173;State='Listen';OwningProcess=1234}) }
    try { Assert-NoHarnessListener; throw 'Expected listener STOP was not raised.' } catch { if($_.Exception.Message -notmatch 'port 4173 has listener'){throw}; $present='STOP' }
    $script:ListenerProbe={ throw 'SIMULATED_PROVIDER_FAILURE' }
    try { Assert-NoHarnessListener; throw 'Expected provider STOP was not raised.' } catch { if($_.Exception.Message -notmatch 'could not prove port 4173'){throw}; $providerError='STOP' }
    [pscustomobject]@{EmptySnapshot=$empty;PresentListener=$present;ProviderError=$providerError}
  }
  if($probeCases.EmptySnapshot -ne 'PASS' -or $probeCases.PresentListener -ne 'STOP' -or $probeCases.ProviderError -ne 'STOP'){throw 'Listener probe cases failed.'}

  $install = & $module {
    param($configuration)
    $script:ListenerProbe={ @() }; $script:ProcessProbe={ @() }
    Invoke-LabInstall -Configuration $configuration | ConvertFrom-Json
  } $configuration
  $canonicalAssetRoot=[string]$install.AssetRoot
  if($install.Status -ne 'SUCCESS' -or $install.Action -ne 'install' -or -not [string]::Equals($canonicalAssetRoot,(Resolve-Path $dist).Path,[StringComparison]::OrdinalIgnoreCase)){throw "Install end-to-end assertion failed: $($install|ConvertTo-Json -Compress)"}
  foreach($relative in $assets){$canonical=(Resolve-Path (Join-Path $dist $relative)).Path;if(-not(Test-Path (Join-Path $link ('dist-client\'+$relative)) -PathType Leaf) -or -not $canonical.StartsWith((Resolve-Path $dist).Path+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Installed asset assertion failed: $relative"}}
  if(-not(Test-Path $markerOld) -or -not(Test-Path $markerNew)){throw 'Install altered old/task target contents.'}

  $rollback = & $module {
    param($configuration)
    $script:ListenerProbe={ @() }; $script:ProcessProbe={ @() }
    Invoke-LabRollback -Configuration $configuration | ConvertFrom-Json
  } $configuration
  if($rollback.Status -ne 'SUCCESS' -or $rollback.Action -ne 'rollback' -or [string]$rollback.Target -ne $oldTarget){throw "Rollback end-to-end assertion failed: $($rollback|ConvertTo-Json -Compress)"}
  if(-not(Test-Path $markerOld) -or -not(Test-Path $markerNew)){throw 'Rollback altered target contents.'}

  Set-Content -LiteralPath $fakeHost -Value 'patched-host' -Encoding UTF8
  $replaceFailure = & $module {
    param($configuration)
    $script:ListenerProbe={ @() }; $script:ProcessProbe={ @() }
    Set-ExactJunction $script:TaskPlugin $script:OriginalTarget
    $script:HostReplaceProbe={ param($staged,$destination,$preserved) throw 'SIMULATED_HOST_REPLACE_FAILURE' }
    try { Invoke-LabRollback -Configuration $configuration | Out-Null; throw 'Expected atomic Host restore STOP was not raised.' }
    catch { if($_.Exception.Message -notmatch 'Do NOT start Harness' -or $_.Exception.Message -notmatch 'SIMULATED_HOST_REPLACE_FAILURE') { throw }; $_.Exception.Message }
  } $configuration
  $afterFailedRestoreHash=(Get-FileHash -LiteralPath $fakeHost -Algorithm SHA256).Hash
  $afterFailedRestoreJunction=& $module { param($old,$link) Assert-ExactJunction $old -JunctionPath $link } $oldTarget $link
  if($replaceFailure -notmatch 'FinalHostSha256=' -or $replaceFailure -notmatch 'JunctionState=verified-original' -or $afterFailedRestoreHash -ne $configuration.PatchedHostSha256 -or [string]$afterFailedRestoreJunction.Target -ne $oldTarget) { throw 'Atomic Host restore fault injection did not preserve explicit safe evidence.' }
  $atomicRollback = & $module {
    param($configuration)
    $script:ListenerProbe={ @() }; $script:ProcessProbe={ @() }; $script:HostReplaceProbe=$null
    Set-ExactJunction $script:TaskPlugin $script:OriginalTarget
    Invoke-LabRollback -Configuration $configuration | ConvertFrom-Json
  } $configuration
  if($atomicRollback.Status -ne 'SUCCESS' -or $atomicRollback.HostSha256 -ne $configuration.OriginalHostSha256) { throw 'Successful atomic Host restore verification failed.' }
  $script:HostReplaceProbe=$null

  $failure = & $module {
    param($link,$old,$plugin)
    try {$creator={param($path,$target)throw 'SIMULATED_CREATE_FAILURE'};Set-ExactJunction $plugin $old -JunctionPath $link -CreateLink $creator;throw 'Expected creation failure was not raised.'}
    catch { $_.Exception.Message }
  } $link $oldTarget $plugin
  if($failure -notmatch 'switch failed; original junction restored and verified.*SIMULATED_CREATE_FAILURE'){throw "Partial failure recovery assertion failed: $failure"}
  $recovery = & $module {param($link,$old)Assert-ExactJunction $old -JunctionPath $link} $link $oldTarget
  if(-not(Test-Path $markerOld) -or -not(Test-Path $markerNew)){throw 'Partial failure recovery altered target contents.'}

  [pscustomobject]@{Status='SUCCESS';ProductionPayloadChecked=$productionPluginRoot;ProductionDistFiles=$builtFiles;ListenerEmpty=$probeCases.EmptySnapshot;ListenerPresent=$probeCases.PresentListener;ListenerProviderError=$probeCases.ProviderError;MissingConfiguration=$missingArguments;ListenerMutationGate=$listenerMutationGate;InstallStatus=$install.Status;InstalledTarget=$install.Target;CanonicalAssetRoot=$canonicalAssetRoot;AssetsChecked=$assets.Count;RollbackStatus=$rollback.Status;RollbackTarget=$rollback.Target;PartialFailureRecoveredTarget=([string]$recovery.Target);OldAndTaskTargetsPreserved=$true;SimulatedCreateFailureRecovered=$true}|ConvertTo-Json -Compress
} finally {
  if($null -ne $module){Remove-Module -ModuleInfo $module -Force -ErrorAction SilentlyContinue}
  if(Test-Path -LiteralPath $link){$item=Get-Item -LiteralPath $link -Force;if($item.LinkType -eq 'Junction' -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Remove-Item -LiteralPath $link -Force}}
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
