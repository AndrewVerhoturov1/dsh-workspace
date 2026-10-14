/** Pure, public game data types. No DOM, React, Three.js or mutable game APIs here. */

/** World x = east, world z = south; N means negative z. */
export type Side = 'N' | 'E' | 'S' | 'W';
/** Clockwise quarter turns when viewed from above. */
export type Rotation = 0 | 1 | 2 | 3;
export type Terrain = 'field' | 'road' | 'city';
/** L/R means the observer is at tile centre looking out along the side. */
export type FieldPort = `${Side}:${'L' | 'R'}`;
/** Lowercase kebab-case; unique within its TileDef. */
export type LocalRegionId = string;

export interface Anchor {
  /** Local east coordinate, from -0.5 to +0.5. */
  readonly u: number;
  /** Local south coordinate, from -0.5 to +0.5. */
  readonly v: number;
}

interface BaseRegion {
  readonly id: LocalRegionId;
  readonly anchor: Anchor;
}

export interface CityRegion extends BaseRegion {
  readonly kind: 'city';
  /** Border sides belonging to this contiguous city part (unrotated tile). */
  readonly sides: readonly Side[];
  /** Number of shield symbols in this local city part. */
  readonly shields: number;
}

export interface RoadRegion extends BaseRegion {
  readonly kind: 'road';
  readonly sides: readonly Side[];
}

export interface FieldRegion extends BaseRegion {
  readonly kind: 'field';
  /** Each field or road side supplies an L and R port, owned exactly once. */
  readonly ports: readonly FieldPort[];
  /** Local city-region IDs touching this field, independent of drawing. */
  readonly touchingCities: readonly LocalRegionId[];
}

export interface MonasteryRegion extends BaseRegion {
  readonly kind: 'monastery';
}

export type TileRegion =
  | CityRegion
  | RoadRegion
  | FieldRegion
  | MonasteryRegion;

export interface TileDef {
  /** Stable definition ID; different copies share the same ID. */
  readonly id: string;
  /** Positive integer. The complete base72 catalog totals exactly 72. */
  readonly copies: number;
  /** Rotational symmetry order: 1 = none, 2 = 180°, 4 = 90°. */
  readonly rotationalSymmetry: 1 | 2 | 4;
  /** Edge types in N, E, S, W order at rotation 0. */
  readonly edges: readonly [Terrain, Terrain, Terrain, Terrain];
  /** Separate local components, not one entry per kind. */
  readonly regions: readonly TileRegion[];
}

export interface TileCatalog {
  readonly rulesetId: 'base72';
  /** Version of rules and tile geometry, distinct from save schema version. */
  readonly version: number;
  readonly startTileId: string;
  readonly definitions: readonly TileDef[];
}

/** CSS #RRGGBB (runtime validation is required). */
export type PlayerColor = `#${string}`;
export type HeraldicSymbol = 'lion' | 'eagle' | 'tower' | 'sun' | 'oak';
export type PlayerId = 'p1' | 'p2' | 'p3' | 'p4' | 'p5';

export interface PlayerSetup {
  readonly name: string;
  readonly color: PlayerColor;
  readonly heraldicSymbol: HeraldicSymbol;
}

export interface Player extends PlayerSetup {
  /** Assigned by the engine in setup order (p1 through p5). */
  readonly id: PlayerId;
}

export interface CreateGameInput {
  /** Arbitrary nonempty string; do not coerce to number. */
  readonly seed: string;
  /** Exactly 2 to 5 players, in seating order. */
  readonly players: readonly PlayerSetup[];
}

export type TileInstanceId = `tile-${string}`;
export type MeepleId = `meeple-${string}`;
export type PlacementId = `place:${number},${number}:r${Rotation}`;
export type RegionTargetId = `region:${number},${number}:${string}`;
export type PickId = PlacementId | RegionTargetId;

export interface TileInstance {
  readonly id: TileInstanceId;
  readonly defId: string;
}

export interface PlacedTile extends TileInstance {
  /** Integer board coordinates. Start tile is at (0, 0). */
  readonly x: number;
  readonly z: number;
  readonly rotation: Rotation;
}

export interface PlacedMeeple {
  readonly id: MeepleId;
  readonly playerId: PlayerId;
  /** Stable original local region target; never a union-find root. */
  readonly targetId: RegionTargetId;
}

export type GamePhase = 'tile' | 'meeple' | 'finished';

export interface GameState {
  readonly rulesetId: 'base72';
  readonly catalogVersion: number;
  readonly seed: string;
  readonly phase: GamePhase;
  /** 1-based turn index; incremented by the engine. */
  readonly turn: number;
  readonly activePlayerId: PlayerId | null;
  readonly players: readonly Player[];
  readonly scores: Readonly<Record<string, number>>;
  readonly meeplesLeft: Readonly<Record<string, number>>;
  readonly board: readonly PlacedTile[];
  /** Includes farmers until final scoring. */
  readonly meeples: readonly PlacedMeeple[];
  /** Remaining order, fully determined by the seed and catalog. */
  readonly bag: readonly TileInstance[];
  readonly pendingTile: TileInstance | null;
  /** Tile placed in the current meeple phase, otherwise null. */
  readonly currentPlacedId: TileInstanceId | null;
  readonly discardedIds: readonly TileInstanceId[];
  /** Accepted user commands only; automatic draws/discards are recomputed. */
  readonly history: readonly GameCommand[];
}

export interface PlacementOption {
  readonly id: PlacementId;
  readonly x: number;
  readonly z: number;
  readonly rotation: Rotation;
}

export interface FollowerTarget {
  readonly id: RegionTargetId;
  readonly tileInstanceId: TileInstanceId;
  readonly regionId: LocalRegionId;
  readonly kind: TileRegion['kind'];
  /** Anchor in unrotated local tile coordinates. */
  readonly anchor: Anchor;
}

export type GameCommand =
  | { readonly type: 'PLACE_TILE'; readonly placementId: PlacementId }
  | { readonly type: 'PLACE_MEEPLE'; readonly targetId: RegionTargetId }
  | { readonly type: 'SKIP_MEEPLE' };

export type GameEvent =
  | { readonly type: 'TILE_DISCARDED'; readonly tileInstanceId: TileInstanceId }
  | { readonly type: 'TILE_PLACED'; readonly tileInstanceId: TileInstanceId; readonly placementId: PlacementId }
  | { readonly type: 'MEEPLE_PLACED'; readonly meepleId: MeepleId; readonly playerId: PlayerId; readonly targetId: RegionTargetId }
  | { readonly type: 'FEATURE_SCORED'; readonly kind: TileRegion['kind']; readonly winnerIds: readonly PlayerId[]; readonly pointsEach: number; readonly completed: boolean }
  | { readonly type: 'MEEPLES_RETURNED'; readonly ids: readonly MeepleId[] }
  | { readonly type: 'TURN_ADVANCED'; readonly turn: number; readonly activePlayerId: PlayerId }
  | { readonly type: 'GAME_FINISHED'; readonly scores: Readonly<Record<string, number>> };

export type GameErrorCode =
  | 'INVALID_PHASE'
  | 'INVALID_COMMAND'
  | 'UNKNOWN_PLACEMENT'
  | 'UNKNOWN_TARGET'
  | 'NO_MEEPLES'
  | 'GAME_FINISHED'
  | 'CORRUPT_STATE';

export interface GameError {
  readonly code: GameErrorCode;
  readonly message: string;
}

export type TransitionResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly state: GameState; readonly error: GameError };

export interface BoardView {
  readonly phase: GamePhase;
  readonly tiles: readonly PlacedTile[];
  readonly meeples: readonly PlacedMeeple[];
  readonly pendingTile: TileInstance | null;
  readonly players: readonly Player[];
  readonly activePlayerId: PlayerId | null;
}

export type TileValidationCode =
  | 'INVALID_ID'
  | 'INVALID_COPIES'
  | 'INVALID_EDGE'
  | 'DUPLICATE_REGION'
  | 'INVALID_ANCHOR'
  | 'INVALID_SIDE'
  | 'DUPLICATE_SIDE'
  | 'INVALID_SHIELDS'
  | 'INVALID_PORT'
  | 'MISSING_PORT'
  | 'DUPLICATE_PORT'
  | 'INVALID_CITY_REF'
  | 'INVALID_SYMMETRY';

export interface TileValidationError {
  readonly code: TileValidationCode;
  readonly path: string;
  readonly message: string;
}

export interface SavedGameV1 {
  readonly schemaVersion: 1;
  readonly rulesetId: 'base72';
  readonly catalogVersion: number;
  /** Deterministic digest of the canonically serialized full catalog. */
  readonly catalogDigest: string;
  readonly seed: string;
  readonly players: readonly PlayerSetup[];
  readonly commands: readonly GameCommand[];
}

export type RestoreErrorCode =
  | 'INVALID_JSON'
  | 'UNSUPPORTED_VERSION'
  | 'CATALOG_MISMATCH'
  | 'INVALID_STATE'
  | 'INVALID_REPLAY';

export interface RestoreError {
  readonly code: RestoreErrorCode;
  readonly message: string;
  readonly detail?: string;
}

export type RestoreResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly error: RestoreError };
