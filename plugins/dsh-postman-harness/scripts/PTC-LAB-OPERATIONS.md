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

Install validates the full parameter set, proves that port 4173 has no listener and no DSH Web process remains, checks the exact current junction and Host state, and verifies the task payload before switching the junction. If any post-switch validation fails, it restores and verifies the original junction; if recovery cannot be proven, do not start Harness. Rollback requires the same stopped-server and exact-target protections and verifies the backup before restoring Host bytes. Start Harness only after an explicit successful install or a fully verified rollback. Never infer a Host backup path or SHA from a different machine, and never run these scripts against a live profile without reviewing the exact arguments and backup first.

The disposable fixture uses temporary junction/Host paths for install and rollback, then separately checks `Assert-TaskPayload` against the built task plugin's exact `client.js`, worker, and WASM inventory without changing any junction. It never uses a user profile or installed Host.
