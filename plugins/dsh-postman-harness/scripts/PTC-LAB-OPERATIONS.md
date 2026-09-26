# PTC Lab install/rollback contract

The install and rollback scripts are deliberately machine-neutral. They have no path, backup, or hash defaults and do not read configuration from environment variables. Supply all seven values explicitly; any missing/empty value, non-absolute path, malformed SHA-256, conflicting path, live Harness listener/process, unexpected junction target, missing payload/backup, or unexpected Host hash is a STOP condition before mutation.

```powershell
$lab = @{
  ProfileJunction = '<absolute profile node_modules junction path>'
  OriginalTarget = '<absolute original plugin directory>'
  TaskPlugin = '<absolute built Lab plugin directory>'
  HostFile = '<absolute installed client-module index.js path>'
  HostBackup = '<absolute verified backup file path>'
  PatchedHostSha256 = '<64 hex SHA-256 for the currently patched Host file>'
  OriginalHostSha256 = '<64 hex SHA-256 expected from the backup/original Host file>'
}

& .\install-ptc-lab.ps1 @lab
# Roll back explicitly with the same complete, verified parameter set:
& .\rollback-ptc-lab.ps1 @lab
```

Every program runs in a disposable browser Worker. The main-thread watchdog terminates the Worker at its bounded deadline even if synchronous QuickJS evaluation cannot yield; promise timeouts and aborts use the same terminate-and-clean-up boundary. Rollback requires the same stopped-server and exact-target protections. It stages the verified backup in the Host directory, checks the staged SHA-256, and uses Windows `File.Replace` with a same-directory preservation copy for atomic replacement; it then checks the final Host SHA and exact original junction. Any failure after junction switching reports `STOP: Do NOT start Harness` with observed Host SHA/junction state. The temporary preservation copy must also match the expected patched Host SHA before it is removed. Start Harness only after an explicit successful install or a fully verified rollback. Never infer a Host backup path or SHA from a different machine, and never run these scripts against a live profile without reviewing the exact arguments and backup first.

The disposable fixture uses temporary junction/Host paths for install and rollback, then separately checks `Assert-TaskPayload` against the built task plugin's exact `client.js`, worker, and WASM inventory without changing any junction. It never uses a user profile or installed Host.
