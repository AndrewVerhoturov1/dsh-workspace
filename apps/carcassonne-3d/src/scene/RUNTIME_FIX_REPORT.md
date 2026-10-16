# Focused scene/runtime repair — 2026-10-14

Status: **implementation and targeted checks PASS; real-browser acceptance pending**. This does not certify GPU availability, route cycling, or visual quality in the Host browser.

## Scope and actual starting state

Worktree: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA. Existing branch: task/postman-0327ba6814bc48b3ab602841c3f1f52f, observed HEAD/base f1a712928324849c94deb7974fe988c43d169370. Read-only initial Git evidence showed untracked apps/; the existing files were inspected and preserved. No branch, worktree, Git publication, dependency, package, config, engine/scoring, e2e, or server changes were made by this repair.

## Source-established causes and focused corrections

1. **False WebGL failure:** installed @react-three/fiber Canvas renders its fallback as ordinary React children of the HTML canvas (dist/react-three-fiber.esm.js, lines 177–183). Therefore the old CanvasFailureNotifier useEffect ran even when WebGL was supported, set renderError, and removed the main 3D Canvas. Removed this notifier and the inappropriate Canvas fallback content. Renderer-creation failures are still forwarded by R3F configure().catch(setError) and thrown to the existing SceneBoundary; context-loss listener and genuine BoardFallback2D remain. No speculative GPU context probe, context creation/disposal during render, forced 2D, or error suppression was added.
2. **Secondary React DOM roots:** installed drei Html creates ReactDOM roots per label; its layout cleanup calls target.removeChild(el) and currentRoot.unmount(). This exact source path accounts for the two reported error classes, although the old live caller stack was not captured. Replaced the three Html label sites in RegionMarkers with native SceneLabel billboard sprites. Labels remain visible scene content, not hidden errors. Their CanvasTexture allocation/disposal occurs only in committed effects; no separate DOM roots/removal exist. StrictMode remains enabled.
3. **Preview ownership:** kept the single module-global preview lease and visibility-driven real 3D preview. Lease release notifications now run in a microtask after the current cleanup instead of synchronously granting another Canvas from cleanup. PreviewBoundary still handles actual renderer errors. No extra WebGL probing contexts are created. R3F continues to own renderer teardown; absence of live context growth still requires browser verification.
4. **Four farm anchors only:** D/L field-2 (ports N:R, S:L) now (0.22, -0.22), clear of city circle centered (0.30, 0) and road. O/P field-1 (ports E:L, S:R) now (0.22, -0.10), clear of the ES road and NW city, on the correct city-adjacent farm. An intermediate Worker proposal (0.30, 0.30) was rejected as the wrong de farm and corrected before final verification. Graph, ports, city contacts, counts and scoring are unchanged.
5. RULES_NOTES now accurately records the prior visual matching of all 24 topologies against official B1 pixels, not machine graph certification, and notes prerelease anchor/digest changes.

## Changed source / regression paths

- src/scene/SceneCanvas.tsx
- src/scene/TilePreview3D.tsx
- src/scene/RegionMarkers.tsx
- src/scene/SceneLabel.tsx (new native label)
- src/scene/SceneLabel.test.ts (new)
- src/scene/anchorRegression.test.ts (new)
- src/scene/runtimeRegression.test.tsx (new)
- src/game/catalog/base72.ts (only four anchor values)
- RULES_NOTES.md
- src/scene/RUNTIME_FIX_REPORT.md (this report)

No UI route components required changes.

## Verification on final relevant inputs

Commands ran from apps/carcassonne-3d:

- Sol: npm test -- src/scene/SceneLabel.test.ts — PASS, 1 test. Direct hook harness proves no render-time allocation, committed texture creation and separate disposal for setup/cleanup/setup/cleanup. This is not a mounted-browser StrictMode test.
- Sol: npm test -- src/scene/scene.test.ts src/ui/presentation.test.ts — PASS, 2 files / 13 tests. Existing Three CJS deprecation warning only.
- Worker 1: npx vitest run src/scene/anchorRegression.test.ts — PASS, 4 tests. Checks coordinates, expected field ports/copy counts/city contact, city-circle and sampled actual road-curve/cap clearance; old-anchor counterexamples and correct O/P farm side. Sol reviewed final assertions and coordinates. This is targeted geometry evidence, not a new machine certification of all tile topology.
- Worker 2: npm run test -- --run src/scene/runtimeRegression.test.tsx --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot — PASS, 2 tests. Configured 3D Canvas has no false fallback notifier; actual native marker element composition contains SceneLabel for every region and field port, with correct text/positions. This does not instantiate a GPU renderer.
- Sol: npm run build — PASS, includes npm run check (tsc --noEmit), then Vite 601 modules / production assets. Existing >500 kB chunk warning; no chunking/config change made.
- Sol: exact changed-source trailing-whitespace check — clean. Git diff --check/publication remains with parent because app files are untracked and Git operations are parent-owned.

Earlier incomplete anchor test had Anchor-vs-Point type errors, corrected before final build; the first native-marker regression incorrectly attempted React DOM rendering of Three tags, replaced with actual element-tree assertions before its passing run. Worker 1 unnecessarily ran the pre-existing full 36-test suite once before the focused test assignment; no further full suite / 100-game repetition was requested or performed by Sol. Those old broad results are not substituted for final targeted evidence.

## Browser handoff / remaining acceptance

Immediate parent owns real browser acceptance (Leader Worker 2). Refresh the exact product URL after verifying its owned server is live; this repair did not start or inspect an unowned server and did not navigate the shared browser. Prior report used http://127.0.0.1:5188/ and /tile-lab. Do not infer server liveness from that historical report.

On a supported GPU verify: main board really obtains WebGL and remains 3D; tile placement and meeple phase; camera/fit and visible labels; game → TileLab → game including StrictMode development behavior; one preview owner and no accumulating live contexts; no synchronous React root unmount/removeChild errors. Confirm true GPU absence/renderer failure still yields honest 2D fallback. If actual GPU remains unavailable, retain concrete evidence and report that environment limitation rather than claiming 3D acceptance. No browser/FPS/performance result is claimed here.
