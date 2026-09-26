Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProfileJunction = $null
$script:OriginalTarget = $null
$script:TaskPlugin = $null
$script:HostFile = $null
$script:HostBackup = $null
$script:PatchedHostSha256 = $null
$script:OriginalHostSha256 = $null
$script:AssetNames = @(
  'assets/ptc-lab-browser-worker.mjs',
  'emscripten-module.wasm'
)
$script:ListenerProbe = $null
$script:ProcessProbe = $null

function Get-LabSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Set-LabConfiguration([hashtable]$Configuration) {
  $required = @('ProfileJunction','OriginalTarget','TaskPlugin','HostFile','HostBackup','PatchedHostSha256','OriginalHostSha256')
  if ($null -eq $Configuration) { throw 'STOP: explicit Lab configuration is required.' }
  foreach ($name in $required) {
    if (-not $Configuration.ContainsKey($name) -or [string]::IsNullOrWhiteSpace([string]$Configuration[$name])) {
      throw "STOP: explicit Lab configuration value '$name' is required."
    }
  }
  foreach ($name in @('ProfileJunction','OriginalTarget','TaskPlugin','HostFile','HostBackup')) {
    if (-not [IO.Path]::IsPathRooted([string]$Configuration[$name])) { throw "STOP: '$name' must be an absolute path." }
  }
  foreach ($name in @('PatchedHostSha256','OriginalHostSha256')) {
    if ([string]$Configuration[$name] -notmatch '^[A-Fa-f0-9]{64}$') { throw "STOP: '$name' must be an exact SHA-256." }
  }
  $script:ProfileJunction = [IO.Path]::GetFullPath($Configuration.ProfileJunction)
  $script:OriginalTarget = [IO.Path]::GetFullPath($Configuration.OriginalTarget).TrimEnd('\')
  $script:TaskPlugin = [IO.Path]::GetFullPath($Configuration.TaskPlugin).TrimEnd('\')
  $script:HostFile = [IO.Path]::GetFullPath($Configuration.HostFile)
  $script:HostBackup = [IO.Path]::GetFullPath($Configuration.HostBackup)
  $script:PatchedHostSha256 = ([string]$Configuration.PatchedHostSha256).ToUpperInvariant()
  $script:OriginalHostSha256 = ([string]$Configuration.OriginalHostSha256).ToUpperInvariant()
  if ([string]::Equals($script:ProfileJunction.TrimEnd('\'), $script:OriginalTarget, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($script:ProfileJunction.TrimEnd('\'), $script:TaskPlugin, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($script:OriginalTarget, $script:TaskPlugin, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($script:HostFile, $script:HostBackup, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: Lab configuration paths conflict.'
  }
}

function Assert-NoHarnessListener {
  try {
    $connections = if ($null -ne $script:ListenerProbe) { @(& $script:ListenerProbe) } else { @(Get-NetTCPConnection -ErrorAction Stop) }
    $listeners = @($connections | Where-Object {
      [int]$_.LocalPort -eq 4173 -and [string]$_.State -eq 'Listen'
    })
  } catch {
    throw "STOP: could not prove port 4173 has no listeners: $($_.Exception.Message)"
  }
  if ($listeners.Count -gt 0) {
    throw "STOP: port 4173 has listener(s): $($listeners.OwningProcess -join ','). Close Harness manually, then retry."
  }
  try {
    if ($null -ne $script:ProcessProbe) { $processes = @(& $script:ProcessProbe) }
    else { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  } catch {
    throw "STOP: could not enumerate processes to prove DSH is stopped: $($_.Exception.Message)"
  }
  if ($null -eq $processes) { throw 'STOP: process enumeration returned no provable result.' }
  $owners = @($processes | Where-Object { $_.CommandLine -match '\\dsh\\lib\\bin\.js.*--profile\s+web.*--port\s+4173' })
  if ($owners.Count -gt 0) {
    throw "STOP: DSH web/4173 process(es) still exist: $($owners.ProcessId -join ','). Close Harness manually, then retry."
  }
}

function Assert-ExactJunction([string]$ExpectedTarget, [string]$JunctionPath = $script:ProfileJunction) {
  $junction = [IO.Path]::GetFullPath($JunctionPath)
  $item = Get-Item -LiteralPath $junction -Force
  if ($item.LinkType -ne 'Junction' -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "STOP: expected Directory+ReparsePoint Junction at $junction; found type=$($item.LinkType), attributes=$($item.Attributes)."
  }
  $actual = [string]($item.Target | Select-Object -First 1)
  $expected = [IO.Path]::GetFullPath($ExpectedTarget).TrimEnd('\')
  if (-not [string]::Equals($actual.TrimEnd('\'), $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "STOP: junction target mismatch at '$junction'. Expected '$expected'; actual '$actual'. No changes made."
  }
  $item
}

function Assert-TaskPayload([string]$PluginPath = $script:TaskPlugin) {
  $packagePath = Join-Path $PluginPath 'package.json'
  $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($package.name -ne 'dsh-postman-harness' -or $package.exports.'./client' -ne './dist-client/client.js') {
    throw 'STOP: task package identity/client export mismatch.'
  }
  $client = [IO.Path]::GetFullPath((Join-Path $PluginPath $package.exports.'./client'))
  $root = [IO.Path]::GetFullPath((Split-Path -Parent $client))
  $expectedRoot = [IO.Path]::GetFullPath((Join-Path $PluginPath 'dist-client'))
  if (-not [string]::Equals($root.TrimEnd('\'), $expectedRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: package client export does not place Host asset root at dist-client.'
  }
  $rootItem = Get-Item -LiteralPath $root -Force
  if (-not $rootItem.Exists -or -not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "STOP: dist-client root missing or is a reparse point: $root"
  }
  $files = @($client) + @($script:AssetNames | ForEach-Object { Join-Path $root $_ })
  foreach ($path in $files) {
    $item = Get-Item -LiteralPath $path -Force
    if (-not $item.Exists -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "STOP: client/asset missing, directory, or a reparse point: $path"
    }
    if (-not $path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "STOP: client or asset escapes dist-client root: $path"
    }
  }
  [pscustomobject]@{ ClientPath=$client; AssetRoot=$root }
}

function Assert-InstalledPayloadThroughJunction([string]$ExpectedTarget) {
  [void](Assert-ExactJunction $script:TaskPlugin)
  if (-not [string]::Equals([IO.Path]::GetFullPath($ExpectedTarget).TrimEnd('\'), [IO.Path]::GetFullPath($script:TaskPlugin).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'STOP: expected install target is not the pinned task plugin.'
  }
  $pinned = Assert-TaskPayload -PluginPath $script:TaskPlugin
  $packagePath = Join-Path $script:ProfileJunction 'package.json'
  $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($package.name -ne 'dsh-postman-harness' -or $package.exports.'./client' -ne './dist-client/client.js') {
    throw 'STOP: package identity/client export through junction mismatch.'
  }
  $relativeFiles = @('client.js') + @($script:AssetNames)
  foreach ($relative in $relativeFiles) {
    $through = [IO.Path]::GetFullPath((Join-Path (Join-Path $script:ProfileJunction 'dist-client') $relative))
    $expected = [IO.Path]::GetFullPath((Join-Path $pinned.AssetRoot $relative))
    $relativeCheck = [IO.Path]::GetRelativePath((Join-Path $script:ProfileJunction 'dist-client'), $through)
    if ($relativeCheck -match '(^|[\\/])\.\.([\\/]|$)' -or -not [string]::Equals($relativeCheck.Replace('\','/'), $relative.Replace('\\','/'), [StringComparison]::OrdinalIgnoreCase)) {
      throw "STOP: unexpected path relative to profile junction: $through"
    }
    foreach ($path in @($through, $expected)) {
      $item = Get-Item -LiteralPath $path -Force
      if (-not $item.Exists -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "STOP: missing/directory/reparse payload file: $path"
      }
    }
    if ((Get-LabSha256 $through) -ne (Get-LabSha256 $expected)) { throw "STOP: payload hash differs through junction: $relative" }
  }
  [void](Assert-ExactJunction $script:TaskPlugin)
  Assert-NoHarnessListener
  [pscustomobject]@{ ClientPath=(Join-Path $script:ProfileJunction 'dist-client/client.js'); AssetRoot=$pinned.AssetRoot; CanonicalRoot=$pinned.AssetRoot }
}

function Assert-HostState([ValidateSet('Patched','Original','Either')][string]$AllowedState) {
  if (-not (Test-Path -LiteralPath $script:HostFile -PathType Leaf) -or -not (Test-Path -LiteralPath $script:HostBackup -PathType Leaf)) {
    throw 'STOP: installed Host or exact rollback backup is missing.'
  }
  $hostHash = Get-LabSha256 $script:HostFile
  $backupHash = Get-LabSha256 $script:HostBackup
  if ($backupHash -ne $script:OriginalHostSha256) { throw "STOP: backup SHA mismatch: $backupHash" }
  if ($AllowedState -eq 'Patched' -and $hostHash -ne $script:PatchedHostSha256) { throw "STOP: Host SHA is not expected patched value: $hostHash" }
  if ($AllowedState -eq 'Original' -and $hostHash -ne $script:OriginalHostSha256) { throw "STOP: Host SHA is not original value: $hostHash" }
  if ($AllowedState -eq 'Either' -and $hostHash -notin @($script:PatchedHostSha256,$script:OriginalHostSha256)) { throw "STOP: Host has unknown SHA; refusing overwrite: $hostHash" }
  $hostHash
}

function Set-ExactJunction([string]$NewTarget, [string]$ExpectedCurrentTarget, [string]$JunctionPath = $script:ProfileJunction, [scriptblock]$CreateLink = $null) {
  $savedTarget = [IO.Path]::GetFullPath($ExpectedCurrentTarget).TrimEnd('\')
  $new = [IO.Path]::GetFullPath($NewTarget).TrimEnd('\')
  $junction = [IO.Path]::GetFullPath($JunctionPath)
  if (-not (Test-Path -LiteralPath $new -PathType Container)) { throw "STOP: new target is missing: $new" }
  [void](Assert-ExactJunction $savedTarget -JunctionPath $junction)
  Remove-Item -LiteralPath $junction -Force
  try {
    if ($null -eq $CreateLink) { New-Item -ItemType Junction -Path $junction -Target $new | Out-Null }
    else { & $CreateLink $junction $new }
    [void](Assert-ExactJunction $new -JunctionPath $junction)
  } catch {
    $failure = $_
    try {
      if (Test-Path -LiteralPath $junction) {
        $partial = Get-Item -LiteralPath $junction -Force
        if ($partial.LinkType -ne 'Junction' -or -not ($partial.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          throw "STOP: recovery refused to remove a non-junction path: $junction"
        }
        Remove-Item -LiteralPath $junction -Force
      }
      New-Item -ItemType Junction -Path $junction -Target $savedTarget | Out-Null
      [void](Assert-ExactJunction $savedTarget -JunctionPath $junction)
    } catch {
      throw "STOP: switch failed: $($failure.Exception.Message). Automatic restore also failed: $($_.Exception.Message). Do NOT start Harness. Manually recreate Junction '$junction' → '$savedTarget' and verify Directory+ReparsePoint target before starting."
    }
    throw "STOP: switch failed; original junction restored and verified. Cause: $($failure.Exception.Message)"
  }
}

function Invoke-LabInstall([hashtable]$Configuration) {
  Set-LabConfiguration $Configuration
  Assert-NoHarnessListener
  [void](Assert-ExactJunction $script:OriginalTarget)
  $hostHash = Assert-HostState Patched
  [void](Assert-TaskPayload)
  try {
    Set-ExactJunction $script:TaskPlugin $script:OriginalTarget
    $throughLink = Assert-InstalledPayloadThroughJunction $script:TaskPlugin
    [pscustomobject]@{ Status='SUCCESS'; Action='install'; Junction=$script:ProfileJunction; Target=$script:TaskPlugin; ClientPath=$throughLink.ClientPath; AssetRoot=$throughLink.CanonicalRoot; HostSha256=$hostHash } | ConvertTo-Json -Compress
  } catch {
    $failure = $_
    try {
      $item = Get-Item -LiteralPath $script:ProfileJunction -Force -ErrorAction Stop
      if ($item.LinkType -ne 'Junction' -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Current profile path is not a junction; recovery will not remove it.' }
      $current = [string]($item.Target | Select-Object -First 1)
      if (-not [string]::Equals($current.TrimEnd('\'), $script:TaskPlugin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw "Current link target unexpected: $current" }
      Set-ExactJunction $script:OriginalTarget $script:TaskPlugin
      [void](Assert-ExactJunction $script:OriginalTarget)
    } catch { throw "STOP: post-install verification failed: $($failure.Exception.Message). Automatic rollback failed: $($_.Exception.Message). Do NOT start Harness; restore '$script:ProfileJunction' → '$script:OriginalTarget' manually and verify it." }
    throw "STOP: install verification failed; original target restored and verified. Cause: $($failure.Exception.Message)"
  }
}

function Invoke-LabRollback([hashtable]$Configuration) {
  Set-LabConfiguration $Configuration
  Assert-NoHarnessListener
  $linkExists = Test-Path -LiteralPath $script:ProfileJunction
  if ($linkExists) {
    [void](Assert-ExactJunction $script:TaskPlugin)
  } else {
    $parent = Split-Path -Parent $script:ProfileJunction
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'STOP: profile junction parent missing; state is ambiguous.' }
  }
  $hostHash = Assert-HostState Either
  if ($linkExists) { Set-ExactJunction $script:OriginalTarget $script:TaskPlugin }
  else { New-Item -ItemType Junction -Path $script:ProfileJunction -Target $script:OriginalTarget | Out-Null }
  if ($hostHash -ne $script:OriginalHostSha256) { Copy-Item -LiteralPath $script:HostBackup -Destination $script:HostFile -Force }
  $restoredHash = Get-LabSha256 $script:HostFile
  if ($restoredHash -ne $script:OriginalHostSha256) { throw "STOP: Host rollback SHA mismatch after copy: $restoredHash. Do NOT start Harness." }
  [void](Assert-ExactJunction $script:OriginalTarget)
  [pscustomobject]@{ Status='SUCCESS'; Action='rollback'; Junction=$script:ProfileJunction; Target=$script:OriginalTarget; HostSha256=$restoredHash } | ConvertTo-Json -Compress
}

Export-ModuleMember -Function Assert-NoHarnessListener, Assert-ExactJunction, Assert-TaskPayload, Assert-InstalledPayloadThroughJunction, Assert-HostState, Set-ExactJunction, Invoke-LabInstall, Invoke-LabRollback
