import type { FollowerTarget, GamePhase, PlacementId, PlacementOption, RegionTargetId, Rotation } from '../game';
import { REGION_NAMES, formatCoordinate } from './presentation';

interface ControlsProps {
  phase: GamePhase;
  rotation: Rotation;
  placements: readonly PlacementOption[];
  followerTargets: readonly FollowerTarget[];
  onRotationChange: (direction: -1 | 1) => void;
  onPlacement: (id: PlacementId) => void;
  onFollower: (id: RegionTargetId) => void;
  onSkip: () => void;
  disabled?: boolean;
}

export function Controls({
  phase, rotation, placements, followerTargets,
  onRotationChange, onPlacement, onFollower, onSkip, disabled = false,
}: ControlsProps): React.JSX.Element {
  const options = placements.filter((item) => item.rotation === rotation);
  return (
    <section className="paper-card controls-panel" aria-labelledby="controls-heading">
      <div className="section-heading section-heading--tight">
        <span className="eyebrow">Порядок хода</span>
        <h2 id="controls-heading">
          {phase === 'tile' ? 'Разместите плитку' : phase === 'meeple' ? 'Поставьте фигурку' : 'Партия завершена'}
        </h2>
      </div>
      {phase === 'tile' && (
        <>
          <p className="panel-intro">Выберите поворот и подходящую клетку на трёхмерном поле или в списке ниже.</p>
          <div className="rotate-controls" aria-label="Поворот плитки">
            <button className="btn btn--icon" type="button" aria-label="Повернуть на 90° против часовой стрелки"
              onClick={() => onRotationChange(-1)} disabled={disabled} title="Q — влево">
              <span aria-hidden="true">↶</span> Влево
            </button>
            <output className="rotation-angle" aria-live="polite">{rotation * 90}°</output>
            <button className="btn btn--icon" type="button" aria-label="Повернуть на 90° по часовой стрелке"
              onClick={() => onRotationChange(1)} disabled={disabled} title="E или R — вправо"
              data-testid="rotate-right">
              Вправо <span aria-hidden="true">↷</span>
            </button>
          </div>
          <p className="hint">Клавиши <kbd>Q</kbd> — влево, <kbd>E</kbd> или <kbd>R</kbd> — вправо.</p>
          <div className="list-heading">
            <strong>Допустимые клетки</strong>
            <span className="count-pill">{options.length} из {placements.length}</span>
          </div>
          {options.length === 0 ? (
            <p className="empty-message">Для этого поворота доступных клеток нет. Выберите другой поворот.</p>
          ) : (
            <div className="legal-list" role="group" aria-label="Разрешённые размещения плитки">
              {options.map((option) => (
                <button key={option.id} type="button" className="legal-choice"
                  onClick={() => onPlacement(option.id)} disabled={disabled}
                  data-testid="legal-placement" data-placement-id={option.id}
                  aria-label={'Поставить плитку в клетку ' + option.x + ', ' + option.z + ', поворот ' + rotation * 90 + ' градусов'}>
                  <span className="legal-choice__seal" aria-hidden="true">✥</span>
                  <span>{formatCoordinate(option.x, option.z)}</span>
                  <span className="legal-choice__direction" aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {phase === 'meeple' && (
        <>
          <p className="panel-intro">Выберите предложенную движком область на только что поставленной плитке либо пропустите фигурку.</p>
          {followerTargets.length ? (
            <div className="legal-list legal-list--targets" role="group" aria-label="Разрешённые области фигурки">
              {followerTargets.map((target) => (
                <button key={target.id} type="button" className={'target-choice target-choice--' + target.kind}
                  data-testid="meeple-target" data-target-id={target.id}
                  onClick={() => onFollower(target.id)} disabled={disabled}
                  aria-label={'Разместить фигурку в области ' + target.regionId + ', ' + REGION_NAMES[target.kind]}>
                  <span className="target-choice__kind">{REGION_NAMES[target.kind]}</span>
                  <strong>{target.regionId}</strong>
                  <span className="target-choice__arrow" aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          ) : <p className="empty-message">Сейчас нет доступных областей для фигурки.</p>}
          <button type="button" className="btn btn--secondary btn--wide skip-button"
            onClick={onSkip} disabled={disabled} data-testid="skip-meeple">
            Пропустить фигурку и закончить ход →
          </button>
          <p className="hint">Пропуск передаётся движку, который подсчитывает завершённые области и начинает следующий ход.</p>
        </>
      )}

      {phase === 'finished' && <p className="panel-intro">Все ходы завершены. Победители и очки представлены в летописи результатов.</p>}
    </section>
  );
}
