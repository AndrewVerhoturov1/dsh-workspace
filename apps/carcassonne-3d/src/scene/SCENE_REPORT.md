# SCENE_REPORT — C-S full 3D implementation

Request: REQ_20261014T073044Z_5204
Scope: WRITE_ISOLATED, only apps/carcassonne-3d/src/scene/**
Task worktree: C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-l654HA

## Files delivered

- src/scene/index.ts — frozen public type exports preserved; SceneCanvas / TilePreview3D published; optional 2D artwork and adjacent-pair diagnostic previews.
- src/scene/SceneCanvas.tsx — interactive 3D board; only provided placement/target IDs reach callbacks; legal spots, hovered ghost, board tiles, followers, HUD, WebGL failure boundary and Fit Board.
- src/scene/TilePreview3D.tsx — same 3D tile/art for Tile Lab, four rotations, logical region and field-port overlays. One active WebGL lab preview across mounted previews; others show actual Canvas2D artwork. Includes 2D adjacent-tile seam preview.
- src/scene/TileMesh.tsx — shared beveled cardboard, vertex-colored relief in a single slab draw call, procedural artwork, drop/shortest-angle rotation animation and selection highlight.
- src/scene/MeepleMesh.tsx — original wooden token profile, heraldic symbols and player colors, two draw calls per meeple via merged geometry, physically horizontal farmers with surface clearance and settling animation.
- src/scene/tileArtwork.ts — deterministic drawing from TileDef sides, connected local components and anchors; distinct-region clipping, textured fields, stone/rooflets, shields and monastery. Fixed symmetric terrain profiles at side seams; invariant neutral corners. Cached textures.
- src/scene/RegionMarkers.tsx — clickable supplied FollowerTarget IDs and diagnostic region/port/anchor overlays; userData.pickId on selectable objects.
- src/scene/CameraController.tsx — orbit/pan/zoom, damping, bounds, callback after movement, smooth Fit Board.
- src/scene/TableEnvironment.tsx — procedural oak, leather rails, brass details, warm lighting, soft shadows.
- src/scene/BoardFallback2D.tsx — functional Canvas2D top-down mode when WebGL is absent/lost; legal placement and follower target picking; no fake 3D.
- src/scene/sceneGeometry.ts — pure rotation/anchor and camera calculations; uses game toBoardAnchor as soon as published, matching frozen formula until then.
- src/scene/scene.test.ts — six focused geometry/seam/port/72-tile-fit/module-load tests.
- src/scene/SCENE_REPORT.md — this report.

Existing src/scene/types.ts was not modified. No game, UI, root, lockfile or Git writes.

## Contract and performance

- World axes: +x east, +z south; tile rotation.y = -rotation * PI/2.
- Scene does not calculate legality, scoring or alter GameState.
- onPlacementPick receives IDs only from legalPlacements; onRegionPick only from followerTargets.
- All imagery is original and generated locally, without external packs, branding or new dependencies.
- 2 geometry draws per tile (slab + ink) and per meeple (merged body + heraldry): estimated subtotal 144 draws for 72 tiles plus 70 for 35 meeples, excluding markers/table/renderer costs. Not GPU-benchmarked.
- Demand rendering with invalidation while damping/drop animates. DPR capped at 1.75; resize aware. Single main Canvas and max one additional active 3D Tile Lab preview.

## Checks executed in worktree

1. cd apps/carcassonne-3d && ./node_modules/.bin/tsc --noEmit --pretty false — PASS, zero errors.
2. cd apps/carcassonne-3d && ./node_modules/.bin/vitest run src/scene/scene.test.ts --no-cache --configLoader runner --pool=threads --maxWorkers=1 --reporter=dot — PASS, 1 file, 6/6 tests.
   Vitest printed an external THREE_CJS_DEPRECATED warning, but no failures.

No npm install, build output, Vite server, browser UI automation, agent, commit/push or other workspace writes.

## Remaining integration / verification limits

- At implementation time game/index.ts had only type exports; real game/catalog and runtime geometry helper were unavailable. Scene's internal fallback matches CONTRACT.md and automatically prefers G's helper once exported.
- No browser/GPU visual testing or measured frame rates were run (no server or Computer Use authorization). Integrator should visually smoke-test final 72-tile scenes once G/U are connected.
- Exact internal field polygons are not part of frozen TileDef. Artwork uses topological sides/components/anchors and clips independent cities/roads. Some complex future interiors may require explicitly authored region outlines in a separately agreed API. The canonical side seams and port locations remain deterministic.
