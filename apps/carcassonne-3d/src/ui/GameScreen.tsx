import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getLegalFollowerTargets, getLegalPlacements, selectBoardView,
} from '../game';
import { SceneCanvas, TilePreview3D } from '../scene';
import type {
  FollowerTarget, GameCommand, GameState, PickId, PlacementId, PlacementOption, RegionTargetId, Rotation, TileDef,
} from '../game';
import type { CameraPose } from '../scene';
import { Controls } from './Controls';
import { SaveLoad } from './SaveLoad';
import { GameOverPanel, Scoreboard, TurnIdentity } from './Scoreboard';
import type { EventLogEntry } from './Scoreboard';
import { formatCoordinate, isTypingTarget } from './presentation';

const INITIAL_CAMERA: CameraPose = {
  target: { x: 0, y: 0, z: 0 },
  distance: 8.3,
  azimuth: Math.PI / 4,
  elevation: Math.PI * 0.36,
};

interface GameScreenProps {
  game: GameState;
  definitions: readonly TileDef[];
  logs: readonly EventLogEntry[];
  error: string | null;
  status: string | null;
  onCommand: (command: GameCommand) => void;
  onDownload: () => void;
  onImportText: (text: string) => void;
  onRestart: () => void;
  onOpenLab: () => void;
}

/** The entire hotseat turn loop is driven exclusively by pure G selectors and transition. */
export function GameScreen({
  game, definitions, logs, error, status,
  onCommand, onDownload, onImportText, onRestart, onOpenLab,
}: GameScreenProps): React.JSX.Element {
  const [rotation, setRotation] = useState<Rotation>(0);
  const [camera, setCamera] = useState<CameraPose>(INITIAL_CAMERA);
  const [hovered, setHovered] = useState<PickId | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const board = useMemo(() => selectBoardView(game), [game]);
  const placements = useMemo(() => getLegalPlacements(game), [game]);
  const targets = useMemo(() => getLegalFollowerTargets(game), [game]);
  const defs = useMemo(() => new Map(definitions.map((def) => [def.id, def])), [definitions]);

  useEffect(() => {
    setRotation(0);
    setHovered(null);
  }, [game.pendingTile?.id]);

  const rotate = useCallback((step: -1 | 1) => {
    setRotation((current) => ((current + step + 4) % 4) as Rotation);
  }, []);

  useEffect(() => {
    if (game.phase !== 'tile') return;
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      const code = event.key.toLowerCase();
      if (code === 'q') {
        event.preventDefault();
        rotate(-1);
      } else if (code === 'e' || code === 'r') {
        event.preventDefault();
        rotate(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game.phase, rotate]);

  const place = useCallback((placementId: PlacementId) => {
    if (game.phase !== 'tile' || !placements.some((option: PlacementOption) => option.id === placementId)) return;
    onCommand({ type: 'PLACE_TILE', placementId });
  }, [game.phase, placements, onCommand]);

  const placeFollower = useCallback((targetId: RegionTargetId) => {
    if (game.phase !== 'meeple' || !targets.some((target: FollowerTarget) => target.id === targetId)) return;
    onCommand({ type: 'PLACE_MEEPLE', targetId });
  }, [game.phase, targets, onCommand]);

  const skip = useCallback(() => {
    if (game.phase === 'meeple') onCommand({ type: 'SKIP_MEEPLE' });
  }, [game.phase, onCommand]);

  const currentPlayer = game.players.find((player) => player.id === game.activePlayerId) ?? null;
  const placedThisTurn = game.currentPlacedId
    ? game.board.find((tile) => tile.id === game.currentPlacedId)
    : undefined;
  const activeDefId = game.phase === 'tile' ? game.pendingTile?.defId : placedThisTurn?.defId;
  const activeDef = activeDefId ? defs.get(activeDefId) : undefined;
  const shownRotation: Rotation = game.phase === 'meeple' && placedThisTurn
    ? placedThisTurn.rotation : rotation;

  return (
    <main className="game-layout" id="main-content">
      <div className="game-toolbar">
        <div className="game-toolbar__identity">
          <span className="eyebrow">Текущая летопись · Партия {game.seed}</span>
          <TurnIdentity player={currentPlayer} turn={game.turn} phase={game.phase} />
        </div>
        <div className="game-toolbar__actions">
          <button type="button" className="btn btn--quiet" onClick={onOpenLab}>Лаборатория плиток</button>
          <button type="button" className="btn btn--quiet" onClick={onRestart}>Новая партия</button>
          <SaveLoad canSave onDownload={onDownload} onImportText={onImportText} compact />
        </div>
      </div>

      {(error || status || sceneError) && (
        <div className="game-notices" aria-live="polite">
          {error && <div className="notice notice--error" role="alert">{error}</div>}
          {status && <div className="notice notice--success" role="status">{status}</div>}
          {sceneError && <div className="notice notice--warning" role="status">
            Область просмотра: {sceneError} Выбор доступных действий сохраняется в списках.
          </div>}
        </div>
      )}

      <div className="game-main-grid">
        <div className="game-main-grid__board">
          <section className="board-frame" aria-label="Игровое поле">
            <SceneCanvas
              board={board}
              definitions={definitions}
              legalPlacements={placements}
              followerTargets={targets}
              selectedRotation={rotation}
              camera={camera}
              onPlacementPick={place}
              onRegionPick={placeFollower}
              onHoverChange={setHovered}
              onCameraChange={setCamera}
              onRenderError={setSceneError}
            />
          </section>
          <div className="board-footnote">
            <span>Поле · {game.board.length} плиток</span>
            <span aria-live="polite">
              {hovered
                ? 'Объект под указателем: ' + hovered
                : 'Мышь: вращать · перетаскивать · прокрутка: масштаб'}
            </span>
            <span>«Поле целиком» — кнопка в углу поля</span>
          </div>
          {game.phase === 'finished' && (
            <GameOverPanel game={game} onRestart={onRestart} onSave={onDownload} onOpenLab={onOpenLab} />
          )}
        </div>

        <aside className="game-main-grid__action" aria-label="Действия текущего хода">
          <section className="paper-card pending-tile" aria-labelledby="pending-tile-title">
            <div className="section-heading section-heading--tight">
              <span className="eyebrow">Рука мастера</span>
              <h2 id="pending-tile-title">
                {game.phase === 'tile' ? 'Следующая плитка' : game.phase === 'meeple' ? 'Последняя плитка' : 'Колода'}
              </h2>
            </div>
            {activeDef ? (
              <>
                <div className="pending-tile__preview">
                  <TilePreview3D tile={activeDef} rotation={shownRotation} />
                </div>
                <dl className="tile-meta">
                  <div><dt>Тип</dt><dd>{activeDef.id}</dd></div>
                  <div><dt>Поворот</dt><dd>{shownRotation * 90}°</dd></div>
                  {game.phase === 'meeple' && placedThisTurn &&
                    <div><dt>Клетка</dt><dd>{formatCoordinate(placedThisTurn.x, placedThisTurn.z)}</dd></div>}
                  <div><dt>В мешке</dt><dd>{game.bag.length}</dd></div>
                </dl>
              </>
            ) : (
              <div className="pending-tile__empty">
                <span aria-hidden="true">✥</span>
                <p>{game.phase === 'finished' ? 'Все плитки разыграны.' : 'Нет доступной плитки для предпросмотра.'}</p>
              </div>
            )}
          </section>

          <Controls
            phase={game.phase}
            rotation={rotation}
            placements={placements}
            followerTargets={targets}
            onRotationChange={rotate}
            onPlacement={place}
            onFollower={placeFollower}
            onSkip={skip}
          />
        </aside>

        <aside className="game-main-grid__score" aria-label="Счёт и летопись">
          <Scoreboard game={game} logs={logs} />
        </aside>
      </div>
      <div className="game-mobile-instructions">
        Список ходов и очков находится ниже поля. При смене участника передайте устройство следующему игроку.
      </div>
    </main>
  );
}
