import { useMemo, useState } from 'react';
import { rotateFieldPort, rotateSide, validateTileDef } from '../game';
import { TileArtworkPreview2D, TilePairPreview2D, TilePreview3D } from '../scene';
import type { FieldPort, Rotation, Side, Terrain, TileCatalog, TileDef, TileRegion, TileValidationError } from '../game';
import { REGION_NAMES, ROTATIONS, TERRAIN_NAMES } from './presentation';

const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const SIDE_NAMES: Record<Side, string> = { N: 'Север', E: 'Восток', S: 'Юг', W: 'Запад' };

function terrainAt(def: TileDef, rotation: Rotation, side: Side): Terrain {
  const sourceSide = SIDES.find((source) => rotateSide(source, rotation) === side);
  return def.edges[SIDES.indexOf(sourceSide ?? 'N')]!;
}

function rotatedSides(sides: readonly Side[], rotation: Rotation): string {
  return sides.length ? sides.map((side) => rotateSide(side, rotation)).join(' · ') : 'внутренняя область';
}

function rotatedPorts(ports: readonly FieldPort[], rotation: Rotation): string[] {
  return ports.map((port) => rotateFieldPort(port, rotation));
}

function portOwner(def: TileDef, rotation: Rotation, port: FieldPort): string {
  const region = def.regions.find((candidate) => candidate.kind === 'field'
    && candidate.ports.some((original) => rotateFieldPort(original, rotation) === port));
  return region?.id ?? 'порт не назначен';
}

function RegionInfo({ region, rotation }: { region: TileRegion; rotation: Rotation }): React.JSX.Element {
  return (
    <li className={'lab-region lab-region--' + region.kind}>
      <div className="lab-region__top">
        <span className="region-kind">{REGION_NAMES[region.kind]}</span>
        <strong>{region.id}</strong>
      </div>
      <dl className="lab-region__facts">
        <div><dt>Якорь (u, v)</dt><dd>{region.anchor.u.toFixed(3)} · {region.anchor.v.toFixed(3)}</dd></div>
        {(region.kind === 'city' || region.kind === 'road') &&
          <div><dt>Стороны после поворота</dt><dd>{rotatedSides(region.sides, rotation)}</dd></div>}
        {region.kind === 'city' && <div><dt>Щитов</dt><dd>{region.shields}</dd></div>}
        {region.kind === 'field' && (
          <>
            <div><dt>Порты после поворота</dt><dd className="port-tags">
              {rotatedPorts(region.ports, rotation).map((port) =>
                <code key={port} className="port-tag">{port}</code>)}
            </dd></div>
            <div><dt>Соседние части города</dt><dd>
              {region.touchingCities.length ? region.touchingCities.join(', ') : 'нет'}
            </dd></div>
          </>
        )}
        {region.kind === 'monastery' && <div><dt>Особенность</dt><dd>Монастырь · самостоятельная область</dd></div>}
      </dl>
    </li>
  );
}

interface TileLabProps {
  catalog: TileCatalog;
  onBack: () => void;
}

export function TileLab({ catalog, onBack }: TileLabProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(catalog.definitions[0]?.id ?? '');
  const [rotation, setRotation] = useState<Rotation>(0);
  const [showAnchors, setShowAnchors] = useState(true);
  const [showPorts, setShowPorts] = useState(true);
  const [query, setQuery] = useState('');
  const [neighborId, setNeighborId] = useState(catalog.definitions[0]?.id ?? '');
  const [neighborRotation, setNeighborRotation] = useState<Rotation>(0);
  const tile = catalog.definitions.find((item) => item.id === selectedId) ?? catalog.definitions[0];
  const neighbor = catalog.definitions.find((item) => item.id === neighborId) ?? catalog.definitions[0];
  const visible = useMemo(() => catalog.definitions.filter((item) => item.id.toLowerCase().includes(query.trim().toLowerCase())), [catalog.definitions, query]);
  const copies = catalog.definitions.reduce((sum, item) => sum + item.copies, 0);
  const validation = useMemo(() => tile ? validateTileDef(tile) : [], [tile]);

  if (!tile || !neighbor) {
    return (
      <main id="main-content" className="lab-layout">
        <div className="paper-card empty-message">Каталог не содержит плиток. Вернитесь к игре.</div>
        <button className="btn btn--primary" type="button" onClick={onBack}>← Назад</button>
      </main>
    );
  }

  const leftEdge = terrainAt(tile, rotation, 'E');
  const rightEdge = terrainAt(neighbor, neighborRotation, 'W');
  const seamMatches = leftEdge === rightEdge;
  const portPairs: readonly [FieldPort, FieldPort][] = [
    ['E:L', 'W:R'], ['E:R', 'W:L'],
  ];

  return (
    <main className="lab-layout" id="main-content">
      <div className="lab-heading">
        <div>
          <span className="eyebrow">Атлас земель · правила хранит движок</span>
          <h1>Лаборатория плиток</h1>
          <p>Весь каталог, четыре поворота, компоненты областей и точные полевые порты. Только просмотр — без изменения определений партии.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={onBack}>← Вернуться</button>
      </div>
      <div className="lab-grid">
        <aside className="paper-card lab-catalog" aria-label="Каталог определений плиток">
          <div className="section-heading section-heading--tight">
            <span className="eyebrow">Основа набора · версия {catalog.version}</span>
            <h2>Виды плиток</h2>
            <p>{catalog.definitions.length} определений · {copies} экземпляров</p>
          </div>
          <label className="form-field">
            <span>Поиск по идентификатору</span>
            <input type="search" value={query} placeholder="Например, city"
              onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="lab-catalog__scroll" role="group" aria-label="Все виды плиток">
            {visible.map((def) => (
              <button
                key={def.id} type="button"
                className={'lab-catalog__item' + (tile.id === def.id ? ' is-selected' : '')}
                aria-pressed={tile.id === def.id}
                onClick={() => { setSelectedId(def.id); setRotation(0); }}
                data-testid="lab-definition"
                data-definition-id={def.id}
              >
                <span className="lab-catalog__icon" aria-hidden="true">▦</span>
                <span className="lab-catalog__name">{def.id}{def.id === catalog.startTileId &&
                  <span className="lab-catalog__start">старт</span>}</span>
                <span className="count-pill">×{def.copies}</span>
              </button>
            ))}
            {visible.length === 0 && <p className="empty-message">Совпадений нет. Уберите условие поиска.</p>}
          </div>
        </aside>

        <section className="paper-card lab-inspector" aria-label="Просмотр выбранной плитки">
          <div className="section-heading section-heading--tight">
            <span className="eyebrow">Архивный лист</span>
            <h2>{tile.id}</h2>
            <p>Копий в наборе: {tile.copies} · симметрия: {tile.rotationalSymmetry}</p>
          </div>
          <div className="rotation-tabs" role="group" aria-label="Поворот плитки">
            {ROTATIONS.map((value) => (
              <button key={value} type="button" className={value === rotation ? 'is-selected' : ''}
                aria-pressed={value === rotation}
                onClick={() => setRotation(value)} data-testid="lab-rotation">
                {value * 90}°
              </button>
            ))}
          </div>
          <div className="lab-tile-preview">
            <TilePreview3D tile={tile} rotation={rotation} showAnchors={showAnchors} showPorts={showPorts} />
          </div>
          <div className="lab-toggle-bar">
            <label><input type="checkbox" checked={showAnchors}
              onChange={(e) => setShowAnchors(e.target.checked)} /> Якоря и области</label>
            <label><input type="checkbox" checked={showPorts}
              onChange={(e) => setShowPorts(e.target.checked)} /> Полевые порты</label>
          </div>
          <div className="lab-edge-table">
            <h3>Грани после поворота</h3>
            <dl>
              {SIDES.map((side) => (
                <div key={side} className={'lab-edge lab-edge--' + terrainAt(tile, rotation, side)}>
                  <dt>{side} · {SIDE_NAMES[side]}</dt>
                  <dd>{TERRAIN_NAMES[terrainAt(tile, rotation, side)]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="lab-diagnostic">
            <span className={'diagnostic-icon' + (validation.length ? ' diagnostic-icon--bad' : '')} aria-hidden="true">
              {validation.length ? '!' : '✓'}
            </span>
            <div>
              <strong>{validation.length ? 'Ошибки структуры плитки' : 'Проверка структуры пройдена'}</strong>
              <p>{validation.length ? validation.length + ' замечаний валидатора.' : 'Валидатор игрового движка не обнаружил структурных ошибок.'}</p>
            </div>
          </div>
          {validation.length > 0 && <ul className="validation-errors" aria-label="Ошибки определения">
            {validation.map((issue: TileValidationError, index: number) => (
              <li key={issue.code + issue.path + index}>
                <strong>{issue.code} · {issue.path}</strong>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>}
        </section>

        <aside className="paper-card lab-topology" aria-labelledby="lab-topology-title">
          <div className="section-heading section-heading--tight">
            <span className="eyebrow">Топология плитки</span>
            <h2 id="lab-topology-title">Отдельные области</h2>
            <p>{tile.regions.length} участков; идентификаторы не меняются при повороте.</p>
          </div>
          <ul className="lab-regions">
            {tile.regions.map((region) => <RegionInfo key={region.id} region={region} rotation={rotation} />)}
          </ul>
        </aside>
      </div>

      <section className="paper-card lab-seam" aria-labelledby="lab-seam-title">
        <div className="lab-seam__heading">
          <div>
            <span className="eyebrow">Сравнение двух соседей</span>
            <h2 id="lab-seam-title">Совпадение шва</h2>
            <p>Правая грань выбранной плитки сопоставляется с левой гранью соседней. Это проверка рисунка и портов, не расчёт законности игрового хода.</p>
          </div>
          <label className="form-field">
            <span>Правая соседняя плитка</span>
            <select value={neighbor.id} onChange={(e) => setNeighborId(e.target.value)}>
              {catalog.definitions.map((def) => <option key={def.id} value={def.id}>{def.id} (×{def.copies})</option>)}
            </select>
          </label>
          <div className="rotation-tabs rotation-tabs--compact" role="group" aria-label="Поворот соседней плитки">
            {ROTATIONS.map((value) =>
              <button type="button" key={value} className={neighborRotation === value ? 'is-selected' : ''}
                aria-pressed={neighborRotation === value} onClick={() => setNeighborRotation(value)}>
                {value * 90}°
              </button>)}
          </div>
        </div>
        <div className="lab-seam__content">
          <div className="lab-seam__pair">
            <TilePairPreview2D left={tile} right={neighbor}
              leftRotation={rotation} rightRotation={neighborRotation} />
            <div className="lab-seam__pair-ids">
              <span>{tile.id} · {rotation * 90}°</span>
              <span>{neighbor.id} · {neighborRotation * 90}°</span>
            </div>
          </div>
          <div className="lab-seam__inspection">
            <div className={'seam-status ' + (seamMatches ? 'seam-status--ok' : 'seam-status--wrong')}
              role="status">
              <span aria-hidden="true">{seamMatches ? '✓' : '!'}</span>
              <strong>{seamMatches ? 'Типы граней совпадают' : 'Грани несовместимы'}</strong>
            </div>
            <dl className="lab-seam__edges">
              <div><dt>{tile.id} · E</dt><dd>{TERRAIN_NAMES[leftEdge]}</dd></div>
              <div><dt>{neighbor.id} · W</dt><dd>{TERRAIN_NAMES[rightEdge]}</dd></div>
            </dl>
            {seamMatches && leftEdge !== 'city' && (
              <div className="lab-seam__ports">
                <h3>Области на соприкасающихся полевых портах</h3>
                {portPairs.map(([left, right]) => (
                  <div key={left}>
                    <code>{left}</code><span>{portOwner(tile, rotation, left)}</span>
                    <span aria-hidden="true">↔</span>
                    <code>{right}</code><span>{portOwner(neighbor, neighborRotation, right)}</span>
                  </div>
                ))}
              </div>
            )}
            {leftEdge !== rightEdge && <p className="hint">Для реального размещения выбирайте одинаковые типы соприкасающихся сторон.</p>}
          </div>
        </div>
        <details className="lab-seam__flat">
          <summary>Показать плоское изображение выбранной плитки</summary>
          <div className="lab-seam__flat-preview">
            <TileArtworkPreview2D tile={tile} rotation={rotation} showAnchors={showAnchors} showPorts={showPorts} />
          </div>
        </details>
      </section>
    </main>
  );
}
