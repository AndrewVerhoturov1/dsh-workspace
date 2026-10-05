/*
 * Carcassonne Web — research-only catalogue data.
 *
 * This module is deliberately NOT the final game TileSpec. It is a browser
 * research dataset copied from the approved research answer for comparing
 * editions and topology before the edition/model/renderer gates are closed.
 */

export const RESEARCH_STATUS = Object.freeze({
  label: 'research prototype',
  catalogueFrozen: false,
  fullStageLogicTestsPassed: false,
  userAcceptancePassed: false,
  originalTileArtReady: false,
});

export const SIDE_ORDER = Object.freeze(['N', 'E', 'S', 'W']);
export const FULL_EDGE_PORTS = Object.freeze(['N', 'E', 'S', 'W']);
export const HALF_EDGE_PORTS = Object.freeze(['Nw', 'Ne', 'En', 'Es', 'Se', 'Sw', 'Ws', 'Wn']);
export const DECLARED_PORTS = Object.freeze([...FULL_EDGE_PORTS, ...HALF_EDGE_PORTS]);

const PORT_ROTATION_90 = Object.freeze({
  N: 'E', E: 'S', S: 'W', W: 'N',
  Nw: 'En', Ne: 'Es', En: 'Se', Es: 'Sw',
  Se: 'Ws', Sw: 'Wn', Ws: 'Nw', Wn: 'Ne',
});

export function rotatePort(port, quarterTurns = 0) {
  let result = port;
  const turns = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < turns; i += 1) result = PORT_ROTATION_90[result];
  if (!result) throw new Error(`Unknown research port: ${port}`);
  return result;
}

export function rotateNESW(nesw, quarterTurns = 0) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  let chars = [...nesw];
  for (let i = 0; i < turns; i += 1) {
    chars = [chars[3], chars[0], chars[1], chars[2]];
  }
  return chars.join('');
}

function rotateRegion(region, turns) {
  return {
    ...region,
    ports: (region.ports || []).map((port) => rotatePort(port, turns)),
  };
}

export function rotateResearchTile(tile, quarterTurns = 0) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  return {
    ...tile,
    orientation: turns * 90,
    nesw: rotateNESW(tile.nesw, turns),
    cities: tile.cities.map((region) => rotateRegion(region, turns)),
    roads: tile.roads.map((region) => rotateRegion(region, turns)),
    fields: tile.fields.map((region) => rotateRegion(region, turns)),
  };
}

export const SOURCES = Object.freeze([
  {
    id: 'S1', level: 'A', title: 'Z-Man Games — Carcassonne product page',
    url: 'https://www.zmangames.com/game/carcassonne/',
    evidence: '72 Land Tiles; отдельно 12 River Tiles и 5 Abbots.',
    availability: 'Доступен во время исследования.',
  },
  {
    id: 'S2', level: 'A', title: 'Z-Man Games — Carcassonne V3 English rules PDF',
    url: 'https://images.zmangames.com/filer_public/24/b9/24b924f3-b7d0-464f-9d1d-618bd01e38a0/carcassonne_v3_rulesheet_en_revised_ab.pdf',
    evidence: 'URL восстановлен из предыдущего исследования.',
    availability: 'Во время последней research-проверки сервер вернул HTTP 502; не считать заново прочитанным.',
  },
  {
    id: 'S3', level: 'A', title: 'Z-Man Games — V3 supplemental PDF',
    url: 'https://images.zmangames.com/filer_public/39/ae/39aecf66-33ea-48a1-a53a-fcb885cb084b/carcassonne_v3_supplement_en_fixed_jan_20.pdf',
    evidence: 'URL восстановлен из предыдущего исследования.',
    availability: 'Во время последней research-проверки сервер вернул HTTP 502; не считать заново прочитанным.',
  },
  {
    id: 'S4', level: 'A', title: 'Asmodee Deutschland — Carcassonne V3.0',
    url: 'https://www.asmodee.de/produkte/carcassonne-v3',
    evidence: '72 base tiles + River/Abbot отдельно; V3 описан как визуальное обновление.',
    availability: 'Доступен во время исследования.',
    quote: '“Inhaltlich gibt es keine Änderungen.”',
    section: 'Описание Carcassonne V3.0',
  },
  {
    id: 'S5', level: 'B', title: 'Carcassonne Standard Complete Annotated Rules v7.3',
    url: 'https://www.dover.nh.gov/Assets/government/city-operations/library/borrow/library-of-things/carcassonne-rules.pdf',
    evidence: 'C1 contents и documented early C2 shield delta.',
    availability: 'Доступен и проверен во время исследования.',
    quote: '“72 land tiles (including one with a dark reverse)”',
    section: 'Basic Game → Game contents, печатная стр. 10; early C2 shield note — стр. 196.',
  },
  {
    id: 'S6', level: 'B', title: 'CarcassonneCentral — clarification from HiG, 21.08.2024',
    url: 'https://www.carcassonnecentral.com/community/index.php?topic=6711.0',
    evidence: 'Опубликованное разъяснение о логической эквивалентности C1/C2/C3 crossroads.',
    availability: 'Доступен во время исследования.',
  },
  {
    id: 'S7', level: 'C', title: 'nivecher/carcassonne — basic-tiles.xml at exact commit',
    url: 'https://github.com/nivecher/carcassonne/blob/3ac0e0c6e54f5c651eb742bfb194ddc3616789d5/src/main/xml/basic-tiles.xml',
    evidence: 'A–X, quantities, city/road/field components, edgeSegment, pennant, cloister.',
    availability: 'Прочитан через GitHub connector read-only по exact commit.',
  },
  {
    id: 'S8', level: 'C', title: 'CarcassonneCentral — community base-tile counts',
    url: 'https://www.carcassonnecentral.com/community/index.php?topic=5356.90',
    evidence: 'Независимый community count reference; не официальный каталог.',
    availability: 'Доступен во время исследования.',
  },
  {
    id: 'S9', level: 'C', title: 'CarcassonneCentral — история base-game rules',
    url: 'https://www.carcassonnecentral.com/community/index.php?topic=2544.0',
    evidence: 'Исторические scoring rules 2000 / 2001 / 2002.',
    availability: 'Доступен во время исследования.',
  },
  {
    id: 'P1', level: 'A', title: 'Asmodee — официальные V3 rules (German)',
    url: 'https://asmodee-resources.azureedge.net/media/germanyprod/Regeln/carcassonne_edition-2021_regel_WEBVERSION.pdf',
    evidence: '84 landscape tiles total, из них 12 River; crossroads road semantics.',
    availability: 'Доступен во время исследования.',
    quote: '“3 Straßen, die von einem Dorf ausgehen.”',
    section: 'Die Straßen, печатная стр. 3.',
  },
  {
    id: 'P2', level: 'A', title: 'Z-Man Games — official English supplement',
    url: 'https://images.zmangames.com/filer_public/14/af/14af825c-9879-42b8-851d-35ce41df7767/carcassonne-supplement.pdf',
    evidence: 'Fields разделяются roads/cities; completed city даёт field 3 points.',
    availability: 'Доступен во время исследования.',
  },
]);

export const EDITION_CANDIDATES = Object.freeze([
  {
    id: 'classic-2002plus',
    label: 'Classic C1 + правила 2002+',
    badge: 'издание C1',
    status: 'кандидат',
    summary: 'Классический 72-тайловый physical set с современной для C1 схемой полей и обычной оценкой двухтайлового города.',
    shieldNote: 'Joined CFCF: 2 экземпляра со щитом + 1 без (C1 research catalogue).',
  },
  {
    id: 'early-c2',
    label: 'Documented early C2',
    badge: 'ранний C2',
    status: 'документированный вариант',
    summary: 'CAR v7.3 документирует перенос одного щита у joined CFCF.',
    shieldNote: 'Joined CFCF: 1 со щитом + 2 без — уровень B, не универсальный факт о всех C2/C3.',
  },
  {
    id: 'modern-c2-c3',
    label: 'Modern C2 / C3',
    badge: 'современные C2/C3',
    status: 'НЕ заморожено',
    summary: 'Connectivity graph не имеет найденного подтверждённого изменения; конкретный print ещё не выбран.',
    shieldNote: 'Per-print multiplicity joined CFCF остаётся нерешённой: официальной per-print таблицы не найдено.',
  },
]);

export const HISTORICAL_NOTE = 'Rules 2000 и 2001 показаны только как историческое объяснение эволюции scoring. Они не являются режимами этого стенда и не выбираются как gameplay configuration.';

export const EARLY_C2_SHIELD_DELTA = Object.freeze({
  classicC1: Object.freeze({ joinedCfcfWithShield: 2, joinedCfcfWithoutShield: 1 }),
  documentedEarlyC2: Object.freeze({ joinedCfcfWithShield: 1, joinedCfcfWithoutShield: 2 }),
  modernC2C3: 'unresolved-per-print',
});

function city(id, ports, options = {}) { return Object.freeze({ id, ports: Object.freeze(ports), ...options }); }
function road(id, ports, options = {}) { return Object.freeze({ id, ports: Object.freeze(ports), ...options }); }
function field(id, ports, touches = []) { return Object.freeze({ id, ports: Object.freeze(ports), touches: Object.freeze(touches) }); }

export const RESEARCH_CATALOGUE = Object.freeze([
  {
    id: 'A', logicalType: 'FFFR-M', quantity: 2, nesw: 'FFRF', startCount: 0,
    cities: [], roads: [road('R1', ['S'], { endsAt: 'M1' })], fields: [field('F1', ['N','E','W','Se','Sw'])],
    monastery: 'M1', shields: [], targets: ['M1','R1','F1'], provenance: 'C1-direct + C2-cross',
  },
  {
    id: 'B', logicalType: 'FFFF-M', quantity: 4, nesw: 'FFFF', startCount: 0,
    cities: [], roads: [], fields: [field('F1', ['N','E','S','W'])], monastery: 'M1', shields: [],
    targets: ['M1','F1'], provenance: 'C1-direct + C2-cross',
  },
  {
    id: 'C', logicalType: 'CCCC-J+', quantity: 1, nesw: 'CCCC', startCount: 0,
    cities: [city('C1', ['N','E','S','W'], { joined: true })], roads: [], fields: [], monastery: null,
    shields: ['C1'], targets: ['C1'], provenance: 'C1-direct',
  },
  {
    id: 'D', logicalType: 'CRFR / start family', quantity: 4, nesw: 'RCRF', startCount: 1,
    cities: [city('C1', ['E'])], roads: [road('R1', ['N','S'])],
    fields: [field('F1', ['W','Nw','Sw']), field('F2', ['Ne','Se'], ['C1'])],
    monastery: null, shields: [], targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived + C2-cross',
  },
  {
    id: 'E', logicalType: 'CFFF', quantity: 5, nesw: 'CFFF', startCount: 0,
    cities: [city('C1', ['N'])], roads: [], fields: [field('F1', ['E','S','W'], ['C1'])],
    monastery: null, shields: [], targets: ['C1','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'F', logicalType: 'CFCF-J+', quantity: 2, nesw: 'FCFC', startCount: 0,
    cities: [city('C1', ['E','W'], { joined: true })], roads: [],
    fields: [field('F1', ['N'], ['C1']), field('F2', ['S'], ['C1'])], monastery: null, shields: ['C1'],
    targets: ['C1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'G', logicalType: 'CFCF-J', quantity: 1, nesw: 'CFCF', startCount: 0,
    cities: [city('C1', ['N','S'], { joined: true })], roads: [],
    fields: [field('F1', ['E'], ['C1']), field('F2', ['W'], ['C1'])], monastery: null, shields: [],
    targets: ['C1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'H', logicalType: 'CFCF-S', quantity: 3, nesw: 'FCFC', startCount: 0,
    cities: [city('C1', ['E'], { separate: true }), city('C2', ['W'], { separate: true })], roads: [],
    fields: [field('F1', ['N','S'], ['C1','C2'])], monastery: null, shields: [],
    targets: ['C1','C2','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'I', logicalType: 'CCFF-S', quantity: 2, nesw: 'FCCF', startCount: 0,
    cities: [city('C1', ['E'], { separate: true }), city('C2', ['S'], { separate: true })], roads: [],
    fields: [field('F1', ['N','W'], ['C1','C2'])], monastery: null, shields: [],
    targets: ['C1','C2','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'J', logicalType: 'CRRF', quantity: 3, nesw: 'CRRF', startCount: 0,
    cities: [city('C1', ['N'])], roads: [road('R1', ['E','S'])],
    fields: [field('F1', ['W','Sw','En'], ['C1']), field('F2', ['Se','Es'])], monastery: null, shields: [],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'K', logicalType: 'CFRR', quantity: 3, nesw: 'RCFR', startCount: 0,
    cities: [city('C1', ['E'])], roads: [road('R1', ['N','W'])],
    fields: [field('F1', ['Wn','Nw']), field('F2', ['S','Ne','Ws'], ['C1'])], monastery: null, shields: [],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'L', logicalType: 'CRRR', quantity: 3, nesw: 'RCRR', startCount: 0,
    cities: [city('C1', ['E'])],
    roads: [road('R1', ['N'], { endsAt: 'V' }), road('R2', ['S'], { endsAt: 'V' }), road('R3', ['W'], { endsAt: 'V' })],
    fields: [field('F1', ['Wn','Nw']), field('F2', ['Ne','Se'], ['C1']), field('F3', ['Ws','Sw'])],
    monastery: null, shields: [], targets: ['C1','R1','R2','R3','F1','F2','F3'],
    provenance: 'C1-direct/derived + C2-cross + A/B-rule',
  },
  {
    id: 'M', logicalType: 'CCFF-J+', quantity: 2, nesw: 'CFFC', startCount: 0,
    cities: [city('C1', ['N','W'], { joined: true })], roads: [], fields: [field('F1', ['E','S'], ['C1'])],
    monastery: null, shields: ['C1'], targets: ['C1','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'N', logicalType: 'CCFF-J', quantity: 3, nesw: 'CFFC', startCount: 0,
    cities: [city('C1', ['N','W'], { joined: true })], roads: [], fields: [field('F1', ['E','S'], ['C1'])],
    monastery: null, shields: [], targets: ['C1','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'O', logicalType: 'CCRR-J+', quantity: 2, nesw: 'CRRC', startCount: 0,
    cities: [city('C1', ['N','W'], { joined: true })], roads: [road('R1', ['E','S'])],
    fields: [field('F1', ['En','Sw'], ['C1']), field('F2', ['Es','Se'])], monastery: null, shields: ['C1'],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'P', logicalType: 'CCRR-J', quantity: 3, nesw: 'CRRC', startCount: 0,
    cities: [city('C1', ['N','W'], { joined: true })], roads: [road('R1', ['E','S'])],
    fields: [field('F1', ['En','Sw'], ['C1']), field('F2', ['Es','Se'])], monastery: null, shields: [],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived',
  },
  {
    id: 'Q', logicalType: 'CCCF-J+', quantity: 1, nesw: 'CCFC', startCount: 0,
    cities: [city('C1', ['N','E','W'], { joined: true })], roads: [], fields: [field('F1', ['S'], ['C1'])],
    monastery: null, shields: ['C1'], targets: ['C1','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'R', logicalType: 'CCCF-J', quantity: 3, nesw: 'CCFC', startCount: 0,
    cities: [city('C1', ['N','E','W'], { joined: true })], roads: [], fields: [field('F1', ['S'], ['C1'])],
    monastery: null, shields: [], targets: ['C1','F1'], provenance: 'C1-direct/derived',
  },
  {
    id: 'S', logicalType: 'CCCR-J+', quantity: 2, nesw: 'CCRC', startCount: 0,
    cities: [city('C1', ['N','E','W'], { joined: true })], roads: [road('R1', ['S'], { endsAt: 'C1' })],
    fields: [field('F1', ['Se'], ['C1']), field('F2', ['Sw'], ['C1'])], monastery: null, shields: ['C1'],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived + C2-cross',
  },
  {
    id: 'T', logicalType: 'CCCR-J', quantity: 1, nesw: 'CCRC', startCount: 0,
    cities: [city('C1', ['N','E','W'], { joined: true })], roads: [road('R1', ['S'], { endsAt: 'C1' })],
    fields: [field('F1', ['Se'], ['C1']), field('F2', ['Sw'], ['C1'])], monastery: null, shields: [],
    targets: ['C1','R1','F1','F2'], provenance: 'C1-direct/derived + C2-cross',
  },
  {
    id: 'U', logicalType: 'RFRF', quantity: 8, nesw: 'RFRF', startCount: 0,
    cities: [], roads: [road('R1', ['N','S'])], fields: [field('F1', ['W','Nw','Sw']), field('F2', ['E','Ne','Se'])],
    monastery: null, shields: [], targets: ['R1','F1','F2'], provenance: 'C1-direct',
  },
  {
    id: 'V', logicalType: 'FFRR', quantity: 9, nesw: 'FFRR', startCount: 0,
    cities: [], roads: [road('R1', ['S','W'])], fields: [field('F1', ['N','E','Se','Wn']), field('F2', ['Ws','Sw'])],
    monastery: null, shields: [], targets: ['R1','F1','F2'], provenance: 'C1-direct',
  },
  {
    id: 'W', logicalType: 'FRRR', quantity: 4, nesw: 'FRRR', startCount: 0,
    cities: [],
    roads: [road('R1', ['E'], { endsAt: 'V' }), road('R2', ['S'], { endsAt: 'V' }), road('R3', ['W'], { endsAt: 'V' })],
    fields: [field('F1', ['N','En','Wn']), field('F2', ['Es','Se']), field('F3', ['Ws','Sw'])],
    monastery: null, shields: [], targets: ['R1','R2','R3','F1','F2','F3'], provenance: 'C1-direct + C2-cross + A-rule',
  },
  {
    id: 'X', logicalType: 'RRRR', quantity: 1, nesw: 'RRRR', startCount: 0,
    cities: [],
    roads: [road('R1', ['N'], { endsAt: 'V' }), road('R2', ['E'], { endsAt: 'V' }), road('R3', ['S'], { endsAt: 'V' }), road('R4', ['W'], { endsAt: 'V' })],
    fields: [field('F1', ['En','Ne']), field('F2', ['Wn','Nw']), field('F3', ['Es','Se']), field('F4', ['Ws','Sw'])],
    monastery: null, shields: [], targets: ['R1','R2','R3','R4','F1','F2','F3','F4'], provenance: 'C1-direct + C2-cross + A-rule',
  },
]);

export function catalogueQuantitySum() {
  return RESEARCH_CATALOGUE.reduce((sum, tile) => sum + tile.quantity, 0);
}

export function regionIds(tile) {
  return new Set([
    ...tile.cities.map((region) => region.id),
    ...tile.roads.map((region) => region.id),
    ...tile.fields.map((region) => region.id),
    ...(tile.monastery ? [tile.monastery] : []),
  ]);
}

export const OPEN_ARCHITECTURE_QUESTIONS = Object.freeze([
  {
    topic: 'Authority topology',
    optionA: 'Topology-first: explicit regions/ports + deterministic derived geometry',
    optionB: 'Geometry-first: partitions/polygons становятся источником истины',
    optionC: '—',
    consequences: 'A1 предложен как стартовый вариант: проще проверять fields, crossroads, joined/separate и rotation. Это рекомендация research report, не approved TileSpec.',
  },
  {
    topic: 'Renderer / composition',
    optionA: 'SVG + raster/vector layers — inspectable result; low–medium complexity; сильный debug; 2.5D и overhang через ручные layers',
    optionB: 'Canvas2D — единый draw loop; medium complexity; debug менее inspectable; 2.5D и depth ordering вручную',
    optionC: 'Three/WebGL — rich camera/depth; high complexity; semantic debug сложнее; strongest 2.5D/depth/overhang',
    consequences: 'SVG — кандидат для первого browser proof, Canvas — альтернатива при реальной SVG-проблеме, Three/WebGL — только при доказанной потребности в depth/camera composition.',
  },
  {
    topic: 'Procedural ↔ art boundary',
    optionA: 'Код: region/port data, masks, road corridor, city/wall footprints, fixed seam band, safe-art masks',
    optionB: 'Art: textures, buildings, trees/decor и controlled shadows внутри safe/overhang contract',
    optionC: 'Seam truth заканчивается на deterministic geometry; art не выводит topology',
    consequences: 'Road/city/field connectivity, field-city contacts и shield ownership не должны зависеть от generated image.',
  },
  {
    topic: 'Два представления сцены',
    optionA: 'Direct-top diagnostic: exact tile boundary, masks, ports, IDs, contacts и seam',
    optionB: 'Angled presentation: roofs, towers, decor, elevation, shadows и controlled overhang',
    optionC: 'Один OrientedTileScene, не два TileSpec',
    consequences: 'Direct-top предложен как seam authority. Angled view служит презентации и не является доказательством логически правильного seam.',
  },
  {
    topic: 'Хранение oriented art',
    optionA: 'Отдельные PNG/WebP/SVG + короткий manifest с mapping 0/90/180/270',
    optionB: 'Premature atlas/build system',
    optionC: 'Preset bridge хранит art mapping, но не игровые свойства',
    consequences: 'До измеренной performance-проблемы отдельные файлы проще. Directional building views должны использовать ту же orientation semantics, что topology; финальный bitmap не следует просто CSS-rotate как фотографию.',
  },
]);
