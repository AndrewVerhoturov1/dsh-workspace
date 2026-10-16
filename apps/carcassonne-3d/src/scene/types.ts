import type {
  BoardView,
  FollowerTarget,
  PickId,
  PlacementId,
  PlacementOption,
  RegionTargetId,
  Rotation,
  TileDef,
} from '../game';

export interface CameraPose {
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  readonly distance: number;
  readonly azimuth: number; // radians
  readonly elevation: number; // radians
}

export interface SceneCanvasProps {
  readonly board: BoardView;
  readonly definitions: readonly TileDef[];
  readonly legalPlacements: readonly PlacementOption[];
  readonly followerTargets: readonly FollowerTarget[];
  readonly selectedRotation: Rotation;
  readonly camera: CameraPose;
  /** Only IDs present in legalPlacements may be sent. */
  readonly onPlacementPick: (id: PlacementId) => void;
  /** Only IDs present in followerTargets may be sent. */
  readonly onRegionPick: (id: RegionTargetId) => void;
  readonly onHoverChange: (id: PickId | null) => void;
  readonly onCameraChange: (next: CameraPose) => void;
  readonly onRenderError: (message: string) => void;
}

export interface TilePreview3DProps {
  readonly tile: TileDef;
  readonly rotation: Rotation;
  readonly showAnchors?: boolean;
  readonly showPorts?: boolean;
}
