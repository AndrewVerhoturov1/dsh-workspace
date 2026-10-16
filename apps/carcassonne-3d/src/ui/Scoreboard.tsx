import type { GameEvent, GameState, Player } from '../game';
import { HeraldicMark, PlayerIdentity } from './Heraldry';
import { HERALDRY, eventDescription, rankPlayers } from './presentation';

export interface EventLogEntry {
  id: string;
  turn: number;
  event: GameEvent;
}

interface ScoreboardProps {
  game: GameState;
  logs: readonly EventLogEntry[];
}

export function Scoreboard({ game, logs }: ScoreboardProps): React.JSX.Element {
  const ranked = rankPlayers(game.players, game.scores);
  return (
    <>
      <section className="paper-card scoreboard" aria-labelledby="scoreboard-heading">
        <div className="section-heading section-heading--tight">
          <span className="eyebrow">Совет земель</span>
          <h2 id="scoreboard-heading">Очки и фигурки</h2>
        </div>
        <ol className="scoreboard__players">
          {ranked.map(({ player, points, rank }) => (
            <li key={player.id} className={'scoreboard__player' + (game.activePlayerId === player.id ? ' is-active' : '')}>
              <span className="scoreboard__rank">{rank}</span>
              <HeraldicMark symbol={player.heraldicSymbol} color={player.color} />
              <div className="scoreboard__person">
                <strong>{player.name}</strong>
                <span className="scoreboard__symbol">{HERALDRY[player.heraldicSymbol].label}</span>
              </div>
              <div className="scoreboard__totals">
                <strong>{points} <small>очк.</small></strong>
                <span>Фигурок: {game.meeplesLeft[player.id] ?? 0}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="scoreboard__foot">
          <span>Плиток на столе</span><strong>{game.board.length}</strong>
          <span>В мешке</span><strong>{game.bag.length}</strong>
          <span>Сброшено</span><strong>{game.discardedIds.length}</strong>
        </div>
      </section>
      <section className="paper-card chronicle" aria-labelledby="chronicle-title">
        <div className="section-heading section-heading--tight">
          <span className="eyebrow">Летопись</span>
          <h2 id="chronicle-title">События и подсчёт</h2>
        </div>
        {logs.length === 0
          ? <p className="empty-message">Здесь появятся выложенные плитки, новые фигурки и начисленные движком очки. После загрузки показываются события текущего сеанса.</p>
          : <ol className="chronicle__entries" aria-live="polite" aria-relevant="additions">
            {logs.map((entry) => (
              <li key={entry.id} className={'chronicle__entry chronicle__entry--' + entry.event.type.toLowerCase()}>
                <span className="chronicle__turn">Ход {entry.turn}</span>
                <span>{eventDescription(entry.event, game.players)}</span>
              </li>
            ))}
          </ol>}
      </section>
    </>
  );
}

interface GameOverProps {
  game: GameState;
  onRestart: () => void;
  onSave: () => void;
  onOpenLab: () => void;
}

export function GameOverPanel({ game, onRestart, onSave, onOpenLab }: GameOverProps): React.JSX.Element {
  const ranked = rankPlayers(game.players, game.scores);
  const winners = ranked.filter((item) => item.winning);
  const isTie = winners.length > 1;
  return (
    <section className="game-over paper-card" aria-labelledby="game-over-title" data-testid="game-over">
      <span className="eyebrow">Последняя страница летописи</span>
      <h2 id="game-over-title">Партия завершена</h2>
      <p className="game-over__subtitle">{isTie ? 'Равный итог — несколько победителей' : 'Победитель земель'}</p>
      <div className="game-over__winners">
        {winners.map((row) => (
          <div className="game-over__winner" key={row.player.id}>
            <HeraldicMark symbol={row.player.heraldicSymbol} color={row.player.color} size="lg" />
            <span>{row.player.name}</span>
            <strong>{row.points} очк.</strong>
          </div>
        ))}
      </div>
      <ol className="game-over__standings" aria-label="Окончательные результаты">
        {ranked.map(({ player, rank, points }) => (
          <li key={player.id}>
            <span>{rank}.</span>
            <PlayerIdentity player={player} />
            <strong>{points}</strong>
          </li>
        ))}
      </ol>
      <div className="game-over__actions">
        <button type="button" className="btn btn--primary" onClick={onRestart}>Новая партия</button>
        <button type="button" className="btn btn--secondary" onClick={onSave}>Скачать летопись</button>
        <button type="button" className="btn btn--quiet" onClick={onOpenLab}>Лаборатория плиток</button>
      </div>
      <p className="hint">Результаты вычисляет игровой движок. При ничьей победа принадлежит всем игрокам с наибольшим числом очков.</p>
    </section>
  );
}

export function TurnIdentity({ player, turn, phase }: {
  player: Player | null;
  turn: number;
  phase: GameState['phase'];
}): React.JSX.Element {
  if (phase === 'finished') {
    return <div className="turn-identity" data-testid="current-player"><span className="eyebrow">Финал</span><strong>Итоги партии</strong></div>;
  }
  if (!player) {
    return <div className="turn-identity" data-testid="current-player"><strong>Ожидаем участника</strong></div>;
  }
  return (
    <div className="turn-identity" data-testid="current-player">
      <HeraldicMark symbol={player.heraldicSymbol} color={player.color} size="lg" />
      <div>
        <span className="eyebrow">Ход {turn} · {phase === 'tile' ? 'Плитка' : 'Фигурка'}</span>
        <strong>{player.name}</strong>
        <span className="turn-identity__heraldry">Герб: {HERALDRY[player.heraldicSymbol].label}</span>
      </div>
    </div>
  );
}
