import {
  EARLY_C2_SHIELD_DELTA,
  EDITION_CANDIDATES,
  OPEN_ARCHITECTURE_QUESTIONS,
  RESEARCH_CATALOGUE,
  SOURCES,
  catalogueQuantitySum,
  rotateResearchTile,
} from './research-data.mjs';
import {
  CONTROL_DEPTH,
  TILE_SIZE,
  VECTOR_TILES,
  compareNeighbourPair,
  getEdgeProfile,
  getRegion,
  regionKindLabel,
  rotateTile,
} from './vector-sample.mjs';

const NS = 'http://www.w3.org/2000/svg';
const SIDE_ORDER = ['N', 'E', 'S', 'W'];
const state = {
  part: 'city',
  comparison: 'roads',
  showConnections: false,
  rotation: 0,
  neighbour: 'fit',
  art: 'roads',
  vectorTile: 'D',
  vectorMode: 'structure',
  vectorRotation: 0,
  vectorPair: 'road',
};

const portPosition = Object.freeze({
  N: [210, 7], E: [413, 210], S: [210, 413], W: [7, 210],
  Nw: [126, 7], Ne: [294, 7], En: [413, 126], Es: [413, 294],
  Se: [294, 413], Sw: [126, 413], Ws: [7, 294], Wn: [7, 126],
});

const palette = Object.freeze({
  city: ['#a9654f', '#765b89', '#9a7951'],
  road: ['#c79a61', '#b87b57', '#8f7b55', '#9d6680'],
  field: ['#78a36e', '#5f9381', '#8c9d62', '#66918e'],
});

const partCopy = Object.freeze({
  city: {
    title: 'Город',
    text: 'Коричневая часть выходит к правому краю. Если город занимает несколько краёв, данные отдельно говорят, соединены эти участки внутри плитки или нет.',
  },
  road: {
    title: 'Дорога',
    text: 'Светлая дорога проходит сверху вниз. Здесь это одна непрерывная часть: вход сверху и выход снизу относятся к одной дороге.',
  },
  field: {
    title: 'Поле',
    text: 'Зелёные области лежат по сторонам дороги. На этой плитке дорога разделяет поле на две отдельные части — левую и правую.',
  },
  monastery: {
    title: 'Монастырь',
    text: 'На основной плитке D монастыря нет, поэтому рядом показан настоящий пример B. Монастырь находится внутри плитки и не заменяет город, дорогу или поле на краю.',
  },
});

const comparisonCopy = Object.freeze({
  roads: {
    leftId: 'U', rightId: 'W', kind: 'road',
    leftTitle: 'Одна непрерывная дорога',
    leftText: 'Вход сверху и выход снизу принадлежат одной и той же дороге.',
    rightTitle: 'Три раздельные дороги',
    rightText: 'Три ветви приходят к одному посёлку, но в текущих данных не превращаются в одну общую дорогу.',
    centerTitle: 'Посёлок не склеивает дороги',
    centerText: 'Нажмите кнопку: каждая самостоятельная дорога получит свой цвет.',
    takeaway: 'Внешне ветви сходятся в одном месте, но их внутреннее устройство остаётся раздельным.',
  },
  cities: {
    leftId: 'F', rightId: 'H', kind: 'city',
    leftTitle: 'Один соединённый город',
    leftText: 'Одна городская область продолжается от правого края до левого.',
    rightTitle: 'Два раздельных города',
    rightText: 'Справа один город, слева другой. Между ними связи нет.',
    centerTitle: 'Края похожи, устройство разное',
    centerText: 'Снаружи расположение городов одинаково. Цвет показывает, принадлежат ли они одной части.',
    takeaway: 'Главное различие находится внутри плитки: похожее расположение на краях не гарантирует соединение.',
  },
  fields: {
    leftId: 'B', rightId: 'U', kind: 'field',
    leftTitle: 'Одно связное поле',
    leftText: 'Поле окружает монастырь и связано со всеми четырьмя сторонами.',
    rightTitle: 'Два поля по сторонам дороги',
    rightText: 'Прямая дорога делит зелёное пространство: слева одно поле, справа другое.',
    centerTitle: 'Дорога может разделять поле',
    centerText: 'Цвет помогает увидеть, сколько самостоятельных зелёных областей хранится в данных.',
    takeaway: 'Монастырь сам по себе поле не делит, а дорога на примере U разделяет его на две части.',
  },
});

const artData = Object.freeze({
  roads: {
    title: 'Дороги и поля',
    src: './references/roads-fields-c.png',
    alt: 'Художественный лист с дорогами, полями, деревьями и небольшими поселениями',
    caption: 'Возможное направление внешнего вида дорог, полей, деревьев и небольших поселений.',
    status: 'Это пример будущего оформления, а не готовые игровые плитки.',
    questions: [
      'Видно ли сразу, где заканчивается поле и начинается дорога?',
      'Не мешают ли деревья увидеть выход дороги на край плитки?',
      'Остаётся ли дорога понятной, если уменьшить плитку?',
    ],
  },
  cities: {
    title: 'Города',
    src: './references/cities-c.png',
    alt: 'Художественный лист с городами, стенами, башнями и щитом',
    caption: 'Возможное направление внешнего вида городских стен, ворот, башен и щита.',
    status: 'Связность городов по этому листу не определяется: её задают отдельные данные.',
    questions: [
      'Понятно ли с первого взгляда, где город должен читаться как одна часть, а где как две раздельные?',
      'Не скрывают ли башни и дома важную границу города?',
      'Достаточно ли заметен щит, не перетягивая всё внимание?',
    ],
  },
  monastery: {
    title: 'Монастырь',
    src: './references/monastery-c.png',
    alt: 'Художественный лист с монастырём в четырёх положениях и примерами окружения',
    caption: 'Лист для сравнения внешнего вида монастыря и его окружения.',
    status: 'Сейчас не утверждается, что четыре изображения физически согласованы как точные виды одного трёхмерного здания.',
    questions: [
      'Кажутся ли четыре вида одним и тем же зданием, увиденным после поворота?',
      'Какие детали лучше всего помогают заметить направление здания?',
      'Не мешает ли объём здания увидеть границы самой плитки?',
    ],
  },
});

const catalogueNames = Object.freeze({
  A: 'Монастырь с дорогой',
  B: 'Монастырь среди поля',
  C: 'Город со всех четырёх сторон, со щитом',
  D: 'Город сбоку и прямая дорога',
  E: 'Город с одной стороны',
  F: 'Один город на противоположных краях, со щитом',
  G: 'Один город на противоположных краях',
  H: 'Два раздельных города напротив друг друга',
  I: 'Два раздельных города на соседних краях',
  J: 'Город и поворот дороги',
  K: 'Город сбоку и поворот дороги',
  L: 'Город и три дороги к посёлку',
  M: 'Город на двух соседних краях, со щитом',
  N: 'Город на двух соседних краях',
  O: 'Город на углу и поворот дороги, со щитом',
  P: 'Город на углу и поворот дороги',
  Q: 'Город на трёх краях, со щитом',
  R: 'Город на трёх краях',
  S: 'Город на трёх краях и дорога, со щитом',
  T: 'Город на трёх краях и дорога',
  U: 'Прямая дорога',
  V: 'Поворот дороги',
  W: 'Три дороги к посёлку',
  X: 'Четыре дороги к посёлку',
});

const editionNames = Object.freeze({
  'classic-2002plus': 'Классическое оформление C1 с более поздними правилами',
  'early-c2': 'Документированный ранний вариант C2',
  'modern-c2-c3': 'Современные варианты C2/C3',
});

const editionCopy = Object.freeze({
  'classic-2002plus': 'Текущая целевая база этой стадии: классический набор из 72 плиток. Исследовательский каталог фиксирует его структуру и известное распределение щитов.',
  'early-c2': 'Историческая справка: для раннего второго оформления документировано отличие в количестве щитов у одного из типов города. Это не переносится автоматически на все более поздние печати.',
  'modern-c2-c3': 'Историческая справка: современная конкретная печать не является целевой базой этого этапа. Подтверждённого изменения связей внутри плиток не найдено, а распределение вариантов со щитом зависит от печати.',
});

function byId(id) {
  return RESEARCH_CATALOGUE.find((tile) => tile.id === id);
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function htmlEl(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of [].concat(children)) node.append(child);
  return node;
}

function linePath(points) {
  return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')}`;
}

function meanPoint(ports, fallback = [210, 210]) {
  if (!ports.length) return fallback;
  const points = ports.map((port) => portPosition[port]);
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function pullTowardCenter([x, y], factor = .5) {
  return [210 + (x - 210) * factor, 210 + (y - 210) * factor];
}

function spread([x, y], index, total, radius = 26) {
  if (total <= 1) return [x, y];
  const angle = ((Math.PI * 2) / total) * index - Math.PI / 2;
  return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius];
}

function addRegionNumber(group, point, number) {
  group.append(svgEl('circle', { cx: point[0], cy: point[1], r: 15, fill: '#34403b' }));
  const text = svgEl('text', { x: point[0], y: point[1] + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'region-number' });
  text.textContent = String(number);
  group.append(text);
}

function renderTile(tileOrId, options = {}) {
  const source = typeof tileOrId === 'string' ? byId(tileOrId) : tileOrId;
  const rotation = options.rotation || 0;
  const tile = rotateResearchTile(source, rotation);
  const focus = options.focus || null;
  const distinct = Boolean(options.distinct);
  const compact = Boolean(options.compact);
  const showNumbers = Boolean(options.showNumbers);
  const svg = svgEl('svg', {
    viewBox: '0 0 420 420',
    role: 'img',
    class: `tile-svg${focus ? ' has-focus' : ''}`,
    'aria-label': `${catalogueNames[source.id] || 'Плитка'}, поворот ${tile.orientation} градусов`,
  });
  svg.append(svgEl('rect', { x: 8, y: 8, width: 404, height: 404, rx: 26, class: 'tile-ground' }));

  const cityHubs = new Map();
  tile.cities.forEach((region, index) => {
    cityHubs.set(region.id, spread(pullTowardCenter(meanPoint(region.ports), region.ports.length > 1 ? .34 : .56), index, tile.cities.length, 22));
  });

  const fieldGroup = svgEl('g', { class: `tile-group field-group${focus === 'field' ? ' is-focused' : ''}` });
  tile.fields.forEach((region, index) => {
    const hub = spread(pullTowardCenter(meanPoint(region.ports), .50), index, tile.fields.length, 35);
    const color = distinct ? palette.field[index % palette.field.length] : palette.field[0];
    for (const port of region.ports) {
      fieldGroup.append(svgEl('path', {
        d: linePath([portPosition[port], hub]),
        stroke: color,
        'stroke-width': compact ? 44 : 70,
        'stroke-linecap': 'round',
        fill: 'none',
        opacity: distinct || focus === 'field' ? .64 : .32,
      }));
    }
    fieldGroup.append(svgEl('circle', { cx: hub[0], cy: hub[1], r: compact ? 24 : 40, fill: color, opacity: distinct || focus === 'field' ? .68 : .38 }));
    if (showNumbers && tile.fields.length > 1) addRegionNumber(fieldGroup, hub, index + 1);
  });
  svg.append(fieldGroup);

  const cityGroup = svgEl('g', { class: `tile-group city-group${focus === 'city' ? ' is-focused' : ''}` });
  tile.cities.forEach((region, index) => {
    const hub = cityHubs.get(region.id);
    const color = distinct ? palette.city[index % palette.city.length] : palette.city[0];
    for (const port of region.ports) {
      cityGroup.append(svgEl('path', {
        d: linePath([portPosition[port], hub]),
        stroke: '#f6eee1',
        'stroke-width': compact ? 56 : 88,
        'stroke-linecap': 'round', fill: 'none', opacity: .96,
      }));
      cityGroup.append(svgEl('path', {
        d: linePath([portPosition[port], hub]),
        stroke: color,
        'stroke-width': compact ? 46 : 72,
        class: 'city-ribbon', fill: 'none',
      }));
    }
    cityGroup.append(svgEl('circle', { cx: hub[0], cy: hub[1], r: compact ? 22 : 33, fill: color }));
    if (tile.shields.includes(region.id) && !compact) {
      cityGroup.append(svgEl('path', {
        d: `M ${hub[0] + 16} ${hub[1] - 27} l 12 4 v 9 c 0 10 -6 15 -12 19 c -6 -4 -12 -9 -12 -19 v -9 z`,
        class: 'shield-mark',
      }));
    }
    if (showNumbers && tile.cities.length > 1) addRegionNumber(cityGroup, hub, index + 1);
  });
  svg.append(cityGroup);

  const monasteryGroup = svgEl('g', { class: `tile-group monastery-group${focus === 'monastery' ? ' is-focused' : ''}` });
  if (tile.monastery) {
    monasteryGroup.append(svgEl('rect', { x: 174, y: 184, width: 72, height: 58, rx: 8, class: 'monastery-building' }));
    monasteryGroup.append(svgEl('path', { d: 'M166 188 L210 150 L254 188 Z', class: 'monastery-roof' }));
    monasteryGroup.append(svgEl('rect', { x: 202, y: 205, width: 16, height: 37, rx: 3, fill: '#795e45' }));
  }
  svg.append(monasteryGroup);

  const roadGroup = svgEl('g', { class: `tile-group road-group${focus === 'road' ? ' is-focused' : ''}` });
  const villageNeeded = tile.roads.some((region) => region.endsAt === 'V');
  tile.roads.forEach((region, index) => {
    const edgePoints = region.ports.map((port) => portPosition[port]);
    let end = null;
    if (region.endsAt === 'V') end = [210, 210];
    else if (region.endsAt === 'M1') end = [210, 210];
    else if (region.endsAt && cityHubs.has(region.endsAt)) end = cityHubs.get(region.endsAt);

    let points;
    let markerPoint;
    if (edgePoints.length >= 2 && !end) {
      const mid = pullTowardCenter(meanPoint(region.ports), .12);
      points = [edgePoints[0], mid, edgePoints[1]];
      markerPoint = mid;
    } else if (edgePoints.length === 1) {
      const target = end || [210, 210];
      points = [edgePoints[0], target];
      markerPoint = [(edgePoints[0][0] + target[0]) / 2, (edgePoints[0][1] + target[1]) / 2];
    } else {
      points = [...edgePoints, end || [210, 210]];
      markerPoint = meanPoint(region.ports);
    }
    const color = distinct ? palette.road[index % palette.road.length] : palette.road[0];
    roadGroup.append(svgEl('path', { d: linePath(points), stroke: '#5a5148', 'stroke-width': compact ? 22 : 30, class: 'road-outline' }));
    roadGroup.append(svgEl('path', { d: linePath(points), stroke: color, 'stroke-width': compact ? 13 : 18, class: 'road-line' }));
    if (showNumbers && tile.roads.length > 1) addRegionNumber(roadGroup, markerPoint, index + 1);
  });
  if (villageNeeded) {
    roadGroup.append(svgEl('path', { d: 'M210 186 L234 210 L210 234 L186 210 Z', class: 'village' }));
  }
  svg.append(roadGroup);

  return svg;
}

function setPressed(hostSelector, dataName, activeValue) {
  document.querySelectorAll(`${hostSelector} [data-${dataName}]`).forEach((button) => {
    button.setAttribute('aria-pressed', button.getAttribute(`data-${dataName}`) === String(activeValue) ? 'true' : 'false');
  });
}

function renderHero() {
  document.querySelector('#hero-tile').replaceChildren(renderTile('D'));
}

function renderPartLesson() {
  const focus = state.part === 'monastery' ? null : state.part;
  document.querySelector('#part-tile').replaceChildren(renderTile('D', { focus, distinct: focus === 'field' }));
  document.querySelector('#monastery-tile').replaceChildren(renderTile('B', { focus: state.part === 'monastery' ? 'monastery' : null }));
  document.querySelector('#monastery-example').classList.toggle('focused', state.part === 'monastery');
  document.querySelector('#part-title').textContent = partCopy[state.part].title;
  document.querySelector('#part-text').textContent = partCopy[state.part].text;
  setPressed('#part-buttons', 'part', state.part);
}

function renderComparison() {
  const copy = comparisonCopy[state.comparison];
  document.querySelector('#compare-left-title').textContent = copy.leftTitle;
  document.querySelector('#compare-right-title').textContent = copy.rightTitle;
  document.querySelector('#compare-left-text').textContent = copy.leftText;
  document.querySelector('#compare-right-text').textContent = copy.rightText;
  document.querySelector('#compare-left-code').textContent = `код ${copy.leftId} — справочно`;
  document.querySelector('#compare-right-code').textContent = `код ${copy.rightId} — справочно`;
  document.querySelector('#compare-center-title').textContent = copy.centerTitle;
  document.querySelector('#compare-center-text').textContent = copy.centerText;
  document.querySelector('#comparison-takeaway').textContent = copy.takeaway;
  const renderOptions = state.showConnections
    ? { distinct: true, showNumbers: true, focus: copy.kind }
    : { distinct: false, showNumbers: false };
  document.querySelector('#compare-left').replaceChildren(renderTile(copy.leftId, renderOptions));
  document.querySelector('#compare-right').replaceChildren(renderTile(copy.rightId, renderOptions));
  document.querySelector('#connections-toggle').textContent = state.showConnections ? 'Скрыть цветовую подсветку' : 'Показать связи цветом';
  setPressed('#comparison-tabs', 'comparison', state.comparison);
}

function rotationText(turns) {
  return [
    '0°: город справа, дорога идёт сверху вниз.',
    '90°: город снизу, та же дорога идёт слева направо.',
    '180°: город слева, дорога снова идёт сверху вниз.',
    '270°: город сверху, дорога идёт слева направо.',
  ][turns];
}

function renderRotation() {
  document.querySelector('#rotation-tile').replaceChildren(renderTile('D', { rotation: state.rotation, distinct: true }));
  document.querySelector('#rotation-description').textContent = `${rotationText(state.rotation)} Внутренние связи не изменились.`;
  setPressed('#rotation-buttons', 'rotation', state.rotation);
  const previews = document.querySelector('#rotation-previews');
  previews.replaceChildren(...[0, 1, 2, 3].map((turns) => {
    const card = htmlEl('div', { class: 'rotation-preview' });
    card.append(renderTile('D', { rotation: turns, compact: true, distinct: true }), htmlEl('span', { text: `${turns * 90}°` }));
    return card;
  }));
}

function renderNeighbour() {
  const stage = document.querySelector('#neighbour-stage');
  const board = htmlEl('div', { class: `pair-board ${state.neighbour}` });
  const d = htmlEl('div', { class: 'pair-tile tile-a' }, renderTile('D', { compact: true }));
  const u = htmlEl('div', { class: 'pair-tile tile-b' }, renderTile('U', { compact: true }));
  const edge = htmlEl('div', { class: 'shared-edge' });
  board.append(d, u, edge);

  if (state.neighbour === 'fit') {
    board.append(
      htmlEl('span', { class: 'edge-chip edge-chip-a', text: 'дорога' }),
      htmlEl('span', { class: 'edge-chip edge-chip-b', text: 'дорога' }),
    );
  } else {
    board.append(
      htmlEl('span', { class: 'edge-chip edge-chip-a', text: 'город' }),
      htmlEl('span', { class: 'edge-chip edge-chip-b', text: 'поле' }),
    );
  }
  stage.replaceChildren(board);

  const result = document.querySelector('#neighbour-result');
  result.className = `neighbour-result ${state.neighbour === 'fit' ? 'good' : 'bad'}`;
  result.textContent = state.neighbour === 'fit'
    ? 'Подходит по виду края: дорога встречается с дорогой.'
    : 'Не подходит: город встречается с полем.';
  setPressed('#neighbour-buttons', 'neighbour', state.neighbour);
}

function renderArt() {
  const item = artData[state.art];
  const image = document.querySelector('#art-main-image');
  image.src = item.src;
  image.alt = item.alt;
  document.querySelector('#art-full-link').href = item.src;
  document.querySelector('#art-open-link').href = item.src;
  document.querySelector('#art-title').textContent = item.title;
  document.querySelector('#art-caption').textContent = item.caption;
  document.querySelector('#art-status').textContent = item.status;
  document.querySelector('#art-question-list').replaceChildren(...item.questions.map((question) => htmlEl('li', { text: question })));
  setPressed('#art-switcher', 'art', state.art);
}

function renderCatalogue() {
  const grid = document.querySelector('#catalogue-grid');
  grid.replaceChildren(...RESEARCH_CATALOGUE.map((tile) => {
    const card = htmlEl('article', { class: 'catalogue-card' });
    card.append(
      renderTile(tile, { compact: true }),
      htmlEl('h3', { text: catalogueNames[tile.id] }),
      htmlEl('p', { text: `код ${tile.id} · ${tile.quantity} шт.${tile.startCount ? ' · один из них стартовый' : ''}` }),
    );
    return card;
  }));
  document.querySelector('#catalogue-summary').textContent = `— ${RESEARCH_CATALOGUE.length} типа, ${catalogueQuantitySum()} экземпляра, один стартовый`;
}

function renderEditions() {
  const list = document.querySelector('#edition-list');
  list.replaceChildren(...EDITION_CANDIDATES.map((edition) => {
    const card = htmlEl('article', { class: 'edition-card' });
    card.append(
      htmlEl('h3', { text: editionNames[edition.id] || edition.label }),
      htmlEl('p', { text: editionCopy[edition.id] || 'Исследовательский вариант издания.' }),
    );
    return card;
  }));
  const c1 = EARLY_C2_SHIELD_DELTA.classicC1;
  const c2 = EARLY_C2_SHIELD_DELTA.documentedEarlyC2;
  document.querySelector('#shield-note').textContent = `В исторической справке: для соединённого города на противоположных краях в классическом C1 зафиксировано ${c1.joinedCfcfWithShield} экземпляра со щитом и ${c1.joinedCfcfWithoutShield} без щита; для документированного раннего C2 — ${c2.joinedCfcfWithShield} со щитом и ${c2.joinedCfcfWithoutShield} без. Современные печати не являются целевой базой этого этапа.`;
}

function renderSources() {
  const list = document.querySelector('#source-list');
  list.replaceChildren(...SOURCES.map((source) => {
    const card = htmlEl('article', { class: 'source-card' });
    const title = htmlEl('h3');
    title.append(htmlEl('span', { class: 'source-level', text: source.level }), document.createTextNode(source.title));
    const link = htmlEl('a', { href: source.url, target: '_blank', rel: 'noreferrer', text: source.url });
    card.append(title, link, htmlEl('p', { text: source.evidence }), htmlEl('p', { class: 'source-limit', text: source.availability }));
    if (source.section) card.append(htmlEl('p', { text: `Где смотреть: ${source.section}` }));
    if (source.quote) card.append(htmlEl('p', { class: 'source-limit', text: `Короткая цитата из источника: ${source.quote}` }));
    return card;
  }));
}

function russianArchitectureTitle(topic) {
  const map = {
    'Authority topology': 'Что считать основой устройства плитки',
    'Renderer / composition': 'Как рисовать результат в браузере',
    'Procedural ↔ art boundary': 'Что задают данные, а что оставлять художнику',
    'Два представления сцены': 'Проверочный вид сверху и красивый наклонный вид',
    'Хранение oriented art': 'Как хранить изображения для разных поворотов',
  };
  return map[topic] || topic;
}

function russianArchitectureConsequence(topic) {
  const map = {
    'Authority topology': 'Предлагается сначала хранить точные связи областей, а форму рисунка получать из них. Это удобнее для проверки полей, перекрёстков, раздельных городов и поворотов, но окончательное решение ещё не принято.',
    'Renderer / composition': 'Для первого небольшого примера проще всего проверить векторный рисунок. Рисование на холсте остаётся альтернативой, а трёхмерный способ имеет смысл только при доказанной потребности в глубине и камере.',
    'Procedural ↔ art boundary': 'Связность дорог, городов и полей должна определяться данными. Текстуры, здания, деревья и тени могут меняться, не меняя устройство плитки.',
    'Два представления сцены': 'Строгий вид сверху нужен для проверки границ и связей. Наклонный объёмный вид нужен для показа оформления и не заменяет проверочный вид.',
    'Хранение oriented art': 'На раннем этапе проще хранить отдельные изображения для нужных поворотов и короткое соответствие направлений. Сложную систему атласов вводить до реальной необходимости не предлагается.',
  };
  return map[topic] || 'Вопрос остаётся открытым и требует проверки на небольшом рабочем примере.';
}

function renderArchitecture() {
  const list = document.querySelector('#architecture-list');
  list.replaceChildren(...OPEN_ARCHITECTURE_QUESTIONS.map((row) => {
    const card = htmlEl('article', { class: 'architecture-card' });
    card.append(
      htmlEl('h3', { text: russianArchitectureTitle(row.topic) }),
      htmlEl('p', { text: russianArchitectureConsequence(row.topic) }),
      htmlEl('p', { class: 'source-limit', text: `Техническая формулировка варианта 1: ${row.optionA}` }),
      htmlEl('p', { class: 'source-limit', text: `Техническая формулировка варианта 2: ${row.optionB}` }),
    );
    if (row.optionC && row.optionC !== '—') card.append(htmlEl('p', { class: 'source-limit', text: `Техническое дополнение: ${row.optionC}` }));
    return card;
  }));
}


const vectorTileChoices = Object.freeze({
  D: 'Город, дорога и два поля',
  U: 'Прямая дорога',
  W: 'Три дороги к одному месту',
  F: 'Один соединённый город',
  H: 'Два раздельных города',
  A: 'Монастырь и дорога',
});

const vectorPairScenarios = Object.freeze({
  road: { aId: 'D', bId: 'U', side: 'S', label: 'Дорога к дороге' },
  city: { aId: 'F', bId: 'H', side: 'E', label: 'Город к городу' },
  field: { aId: 'A', aRotation: 2, bId: 'H', side: 'S', label: 'Поле к полю' },
  wrong: { aId: 'D', bId: 'U', side: 'E', label: 'Намеренная ошибка' },
});

const vectorColors = Object.freeze({
  city: { C1: '#a86450', C2: '#765b89', fallback: '#9b6f5d' },
  road: { R1: '#c99859', R2: '#b87557', R3: '#9c6a82', fallback: '#b68b61' },
  field: { F1: '#7ea56f', F2: '#5f9381', F3: '#8d9e62', fallback: '#769870' },
  monastery: { fallback: '#d9c7a5' },
  junction: { fallback: '#c9bda7' },
});

const sideNames = Object.freeze({ N: 'север', E: 'восток', S: 'юг', W: 'запад' });

function vectorColor(region) {
  const set = vectorColors[region.kind] || {};
  return set[region.id] || set.fallback || '#bdb7aa';
}

function ringPath(points) {
  return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
}

function regionPath(tile, region) {
  const holes = region.holes.map((holeId) => ringPath(getRegion(tile, holeId).outer)).join(' ');
  return `${ringPath(region.outer)} ${holes}`.trim();
}

function polygonNode(points, attrs = {}) {
  return svgEl('polygon', { points: points.map(([x, y]) => `${x},${y}`).join(' '), ...attrs });
}

function centerOfPolygon(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function vectorLabelPoint(tile, region) {
  const zone = tile.meepleZones.find((item) => item.owner === region.id);
  if (zone) return centerOfPolygon(zone.outer);
  return centerOfPolygon(region.outer);
}

function appendSvgText(parent, text, x, y, className, extra = {}) {
  const node = svgEl('text', { x, y, class: className, 'text-anchor': 'middle', 'dominant-baseline': 'middle', ...extra });
  node.textContent = text;
  parent.append(node);
  return node;
}

function drawExactOverlay(svg, tile) {
  const bands = svgEl('g', { class: 'vector-control-bands' });
  bands.append(
    svgEl('rect', { x: CONTROL_DEPTH, y: 0, width: TILE_SIZE - CONTROL_DEPTH * 2, height: CONTROL_DEPTH, class: 'vector-control-band' }),
    svgEl('rect', { x: TILE_SIZE - CONTROL_DEPTH, y: CONTROL_DEPTH, width: CONTROL_DEPTH, height: TILE_SIZE - CONTROL_DEPTH * 2, class: 'vector-control-band' }),
    svgEl('rect', { x: CONTROL_DEPTH, y: TILE_SIZE - CONTROL_DEPTH, width: TILE_SIZE - CONTROL_DEPTH * 2, height: CONTROL_DEPTH, class: 'vector-control-band' }),
    svgEl('rect', { x: 0, y: CONTROL_DEPTH, width: CONTROL_DEPTH, height: TILE_SIZE - CONTROL_DEPTH * 2, class: 'vector-control-band' }),
  );
  svg.append(bands);

  const axis = svgEl('g', { class: 'vector-axis-labels' });
  appendSvgText(axis, '(0,0)', 0, -36, 'vector-axis-text', { 'text-anchor': 'start' });
  appendSvgText(axis, '(1000,0)', 1000, -36, 'vector-axis-text', { 'text-anchor': 'end' });
  appendSvgText(axis, '(1000,1000)', 1000, 1040, 'vector-axis-text', { 'text-anchor': 'end' });
  appendSvgText(axis, '(0,1000)', 0, 1040, 'vector-axis-text', { 'text-anchor': 'start' });

  for (const side of ['N', 'E', 'S', 'W']) {
    const road = getEdgeProfile(tile, side).find((interval) => interval.kind === 'road');
    if (!road) continue;
    for (const value of [road.start, road.end]) {
      if (side === 'N' || side === 'S') {
        const y1 = side === 'N' ? -12 : 1012;
        const y2 = side === 'N' ? 22 : 978;
        axis.append(svgEl('line', { x1: value, y1, x2: value, y2, class: 'vector-road-tick' }));
        appendSvgText(axis, String(value), value, side === 'N' ? -32 : 1032, 'vector-tick-text');
      } else {
        const x1 = side === 'W' ? -12 : 1012;
        const x2 = side === 'W' ? 22 : 978;
        axis.append(svgEl('line', { x1, y1: value, x2, y2: value, class: 'vector-road-tick' }));
        appendSvgText(axis, String(value), side === 'W' ? -34 : 1034, value, 'vector-tick-text');
      }
    }
  }
  svg.append(axis);
}

function drawLayoutOverlay(svg, tile) {
  const layer = svgEl('g', { class: 'vector-layout-layer' });
  for (const zone of tile.layout.allowedZones) layer.append(polygonNode(zone.outer, { class: 'vector-allowed-zone' }));
  for (const zone of tile.meepleZones) layer.append(polygonNode(zone.outer, { class: 'vector-meeple-zone' }));

  for (const wall of tile.layout.walls) {
    layer.append(svgEl('path', { d: linePath(wall.path), class: 'vector-wall-path' }));
  }

  for (const object of tile.layout.objects) {
    const footprint = polygonNode(object.footprint, { class: `vector-object vector-object-${object.type}` });
    layer.append(footprint);
    if (object.type === 'tree') {
      layer.append(svgEl('circle', { cx: object.center[0], cy: object.center[1], r: 20, class: 'vector-tree-crown' }));
    }
    if (object.direction) {
      layer.append(svgEl('line', {
        x1: object.center[0], y1: object.center[1],
        x2: object.center[0] + object.direction[0] * 70,
        y2: object.center[1] + object.direction[1] * 70,
        class: 'vector-direction',
      }));
    }
    const label = object.type === 'building' ? 'здание'
      : object.type === 'shield' ? 'щит'
        : object.type === 'tree' ? 'дерево'
          : 'монастырь';
    appendSvgText(layer, label, object.center[0], object.center[1] - 34, 'vector-object-label');
  }
  svg.append(layer);
}

function renderVectorTile(tileOrId, options = {}) {
  const source = typeof tileOrId === 'string' ? VECTOR_TILES[tileOrId] : tileOrId;
  const rotation = options.rotation || 0;
  const tile = typeof tileOrId === 'string' ? rotateTile(source, rotation) : source;
  const mode = options.mode || 'structure';
  const compact = Boolean(options.compact);
  const svg = svgEl('svg', {
    viewBox: compact ? '0 0 1000 1000' : '-70 -70 1140 1140',
    role: 'img',
    class: `vector-svg vector-mode-${mode}`,
    'aria-label': `${vectorTileChoices[source.id] || source.title}, математический поворот ${rotation * 90} градусов`,
  });
  svg.append(svgEl('rect', { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, rx: compact ? 0 : 16, class: 'vector-ground' }));

  for (const region of tile.regions) {
    svg.append(svgEl('path', {
      d: regionPath(tile, region),
      class: `vector-region vector-${region.kind}`,
      fill: vectorColor(region),
      'fill-rule': 'evenodd',
      'data-region': region.id,
    }));
  }

  if (mode === 'exact' && !compact) drawExactOverlay(svg, tile);
  if (mode === 'layout' && !compact) drawLayoutOverlay(svg, tile);

  if (!compact) {
    const sameKindCounts = tile.regions.reduce((map, region) => map.set(region.kind, (map.get(region.kind) || 0) + 1), new Map());
    for (const region of tile.regions) {
      const [x, y] = vectorLabelPoint(tile, region);
      const label = mode === 'exact'
        ? region.id
        : `${regionKindLabel(region.kind)}${sameKindCounts.get(region.kind) > 1 ? ` ${region.id.replace(/\D/g, '') || region.id}` : ''}`;
      appendSvgText(svg, label, x, y, mode === 'exact' ? 'vector-region-id' : 'vector-region-label');
    }
  }
  svg.append(svgEl('rect', { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE, rx: compact ? 0 : 16, class: 'vector-frame' }));
  return svg;
}

function codeSpan(text) {
  return htmlEl('span', { class: 'vector-code', text });
}

function relationRow(text, code) {
  const li = htmlEl('li');
  li.append(document.createTextNode(text));
  if (code) li.append(document.createTextNode(' '), codeSpan(code));
  return li;
}

function profilePhrase(profile) {
  if (profile.length === 1 && profile[0].start === 0 && profile[0].end === TILE_SIZE) {
    return `весь край — ${regionKindLabel(profile[0].kind)}`;
  }
  return profile.map((interval) => `${regionKindLabel(interval.kind)} ${interval.start}–${interval.end}`).join(' · ');
}

function renderVectorInfo(tile) {
  document.querySelector('#vector-title').textContent = vectorTileChoices[tile.id];
  document.querySelector('#vector-summary').textContent = tile.summary;
  const details = document.querySelector('#vector-details');
  details.replaceChildren();

  if (state.vectorMode === 'structure') {
    const intro = htmlEl('p', { text: 'Каждая цветная область — одна локально связная часть. Одинаковый идентификатор не используется для несвязанных кусков.' });
    const list = htmlEl('ul', { class: 'vector-facts' });
    for (const relation of tile.relationships.endsAt) {
      list.append(relationRow('Дорога заканчивается у внутренней области.', `${relation.road} → ${relation.target}`));
    }
    for (const relation of tile.relationships.fieldCityContacts) {
      list.append(relationRow('Поле и город имеют общую границу ненулевой длины.', `${relation.field} ↔ ${relation.city}`));
    }
    for (const relation of tile.relationships.shields) {
      list.append(relationRow('Щит принадлежит конкретному городу и не является отдельной поверхностью.', `${relation.shield} → ${relation.city}`));
    }
    if (!list.childElementCount) list.append(relationRow('Здесь связность читается прямо из непрерывных цветных областей и их выходов на края.'));
    details.append(intro, list);
  } else if (state.vectorMode === 'exact') {
    const intro = htmlEl('p', { text: `Квадрат 1000×1000. Дорожный выход — 410…590. Полупрозрачная рамка показывает контрольную глубину ${CONTROL_DEPTH}; угловые квадраты в эту проверку не входят.` });
    const coords = htmlEl('ul', { class: 'vector-coordinate-list' });
    for (const region of tile.regions) {
      const row = htmlEl('li');
      row.append(codeSpan(`${region.id}: `), document.createTextNode(region.outer.map(([x, y]) => `(${x},${y})`).join(' → ')));
      coords.append(row);
    }
    const edges = htmlEl('div', { class: 'vector-edge-list' });
    for (const side of ['N', 'E', 'S', 'W']) {
      edges.append(htmlEl('p', { text: `${sideNames[side]}: ${profilePhrase(getEdgeProfile(tile, side))}` }));
    }
    details.append(intro, coords, edges);
  } else {
    const intro = htmlEl('p', { text: 'Пунктиром показаны разрешённые места, толстой линией — будущая стена, а простыми значками — условные здания, щит и деревья. Это ещё не готовые изображения.' });
    const list = htmlEl('ul', { class: 'vector-facts' });
    if (tile.layout.walls.length) list.append(relationRow(`Стены следуют границе город–поле и не входят во внешнюю защитную полосу ${CONTROL_DEPTH}.`));
    if (tile.layout.objects.length) list.append(relationRow(`Ручных условных объектов: ${tile.layout.objects.length}. Их занимаемые контуры целиком лежат в разрешённых зонах.`));
    list.append(relationRow(`Безопасных локальных зон для будущих фишек: ${tile.meepleZones.length}. Сами фишки сейчас не добавляются.`));
    details.append(intro, list);
  }
}

function renderProfileBar(profile, label) {
  const row = htmlEl('div', { class: 'seam-profile-row' });
  row.append(htmlEl('span', { class: 'seam-profile-label', text: label }));
  const bar = htmlEl('div', { class: 'seam-profile-bar' });
  for (const interval of profile) {
    const segment = htmlEl('span', { class: `seam-profile-segment kind-${interval.kind}` });
    segment.style.flexBasis = `${((interval.end - interval.start) / TILE_SIZE) * 100}%`;
    segment.textContent = regionKindLabel(interval.kind);
    bar.append(segment);
  }
  row.append(bar);
  return row;
}

function renderVectorPair() {
  const scenario = vectorPairScenarios[state.vectorPair];
  const result = compareNeighbourPair(scenario);
  const stage = document.querySelector('#vector-pair-stage');
  const board = htmlEl('div', { class: `vector-pair-board side-${scenario.side} ${result.match ? 'match' : 'mismatch'}` });
  const a = htmlEl('div', { class: 'vector-pair-tile vector-pair-a' });
  const b = htmlEl('div', { class: 'vector-pair-tile vector-pair-b' });
  a.append(renderVectorTile(scenario.aId, { compact: true, mode: 'structure', rotation: scenario.aRotation || 0 }), htmlEl('span', { text: `${vectorTileChoices[scenario.aId]}${scenario.aRotation ? ` · ${scenario.aRotation * 90}°` : ''}` }));
  b.append(renderVectorTile(scenario.bId, { compact: true, mode: 'structure', rotation: scenario.bRotation || 0 }), htmlEl('span', { text: `${vectorTileChoices[scenario.bId]}${scenario.bRotation ? ` · ${scenario.bRotation * 90}°` : ''}` }));
  board.append(a, b, htmlEl('div', { class: 'vector-shared-edge' }));
  stage.replaceChildren(board);

  const profiles = document.querySelector('#vector-seam-profile');
  profiles.replaceChildren(
    renderProfileBar(result.profileA, 'Первая сторона'),
    renderProfileBar(result.profileB, 'Вторая сторона'),
  );

  const status = document.querySelector('#vector-pair-result');
  status.className = `vector-pair-result ${result.match ? 'good' : 'bad'}`;
  const first = profilePhrase(result.profileA);
  const second = profilePhrase(result.profileB);
  status.textContent = result.match
    ? `Совпало: ${first}. Контрольная полоса глубиной ${CONTROL_DEPTH} тоже совпадает.`
    : `Не совпало: с первой стороны ${first}, со второй — ${second}. Оформление не может исправить различие математических краёв.`;

  const connections = document.querySelector('#vector-pair-connections');
  if (result.connections.length) {
    connections.textContent = `Техническая проверка ненулевых участков: ${result.connections.map((row) => `${scenario.aId}.${row.aRegion} ↔ ${scenario.bId}.${row.bRegion} на ${row.start}…${row.end}`).join('; ')}.`;
  } else {
    connections.textContent = 'Техническая проверка не нашла ни одного соединяемого участка ненулевой длины.';
  }
  setPressed('#vector-pair-buttons', 'vector-pair', state.vectorPair);
}

function renderVectorSample() {
  const source = VECTOR_TILES[state.vectorTile];
  const tile = rotateTile(source, state.vectorRotation);
  document.querySelector('#vector-tile-host').replaceChildren(renderVectorTile(state.vectorTile, { mode: state.vectorMode, rotation: state.vectorRotation }));
  document.querySelector('#vector-caption').textContent = state.vectorMode === 'structure'
    ? 'Цвет показывает локально связные части. Поворот пересчитывает координаты, а не вращает готовую картинку.'
    : state.vectorMode === 'exact'
      ? 'Точный вид показывает математические границы, координаты, дорожные интервалы и контрольную полосу.'
      : 'Все условные места оформления лежат поверх той же геометрии и не меняют области, связи или края.';
  renderVectorInfo(tile);
  setPressed('#vector-tile-buttons', 'vector-tile', state.vectorTile);
  setPressed('#vector-mode-buttons', 'vector-mode', state.vectorMode);
  setPressed('#vector-rotation-buttons', 'vector-rotation', state.vectorRotation);
  renderVectorPair();
}

function bindControls() {
  document.querySelectorAll('#part-buttons [data-part]').forEach((button) => {
    button.addEventListener('click', () => { state.part = button.dataset.part; renderPartLesson(); });
  });
  document.querySelectorAll('#comparison-tabs [data-comparison]').forEach((button) => {
    button.addEventListener('click', () => {
      state.comparison = button.dataset.comparison;
      state.showConnections = false;
      renderComparison();
    });
  });
  document.querySelector('#connections-toggle').addEventListener('click', () => {
    state.showConnections = !state.showConnections;
    renderComparison();
  });
  document.querySelectorAll('#rotation-buttons [data-rotation]').forEach((button) => {
    button.addEventListener('click', () => { state.rotation = Number(button.dataset.rotation); renderRotation(); });
  });
  document.querySelectorAll('#neighbour-buttons [data-neighbour]').forEach((button) => {
    button.addEventListener('click', () => { state.neighbour = button.dataset.neighbour; renderNeighbour(); });
  });
  document.querySelectorAll('#art-switcher [data-art]').forEach((button) => {
    button.addEventListener('click', () => { state.art = button.dataset.art; renderArt(); });
  });
  document.querySelectorAll('#vector-tile-buttons [data-vector-tile]').forEach((button) => {
    button.addEventListener('click', () => {
      state.vectorTile = button.getAttribute('data-vector-tile');
      state.vectorRotation = 0;
      renderVectorSample();
    });
  });
  document.querySelectorAll('#vector-mode-buttons [data-vector-mode]').forEach((button) => {
    button.addEventListener('click', () => { state.vectorMode = button.getAttribute('data-vector-mode'); renderVectorSample(); });
  });
  document.querySelectorAll('#vector-rotation-buttons [data-vector-rotation]').forEach((button) => {
    button.addEventListener('click', () => { state.vectorRotation = Number(button.getAttribute('data-vector-rotation')); renderVectorSample(); });
  });
  document.querySelectorAll('#vector-pair-buttons [data-vector-pair]').forEach((button) => {
    button.addEventListener('click', () => { state.vectorPair = button.getAttribute('data-vector-pair'); renderVectorPair(); });
  });
}

renderHero();
renderPartLesson();
renderComparison();
renderRotation();
renderNeighbour();
renderArt();
renderVectorSample();
renderCatalogue();
renderEditions();
renderSources();
renderArchitecture();
bindControls();
