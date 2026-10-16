import { useState } from 'react';
import type { CreateGameInput, HeraldicSymbol, PlayerColor, PlayerSetup } from '../game';
import { HeraldicMark } from './Heraldry';
import { HERALDRY } from './presentation';

const DEFAULT_PLAYERS: readonly PlayerSetup[] = [
  { name: 'Игрок 1', color: '#9d4237', heraldicSymbol: 'lion' },
  { name: 'Игрок 2', color: '#35697a', heraldicSymbol: 'eagle' },
  { name: 'Игрок 3', color: '#54733b', heraldicSymbol: 'oak' },
  { name: 'Игрок 4', color: '#866241', heraldicSymbol: 'tower' },
  { name: 'Игрок 5', color: '#79568f', heraldicSymbol: 'sun' },
];

const HERALDIC_OPTIONS = Object.keys(HERALDRY) as HeraldicSymbol[];

interface SetupScreenProps {
  onStart: (input: CreateGameInput) => void;
  onOpenLab: () => void;
  onResume: () => void;
  hasResume: boolean;
  error: string | null;
}

export function SetupScreen({
  onStart, onOpenLab, onResume, hasResume, error,
}: SetupScreenProps): React.JSX.Element {
  const [players, setPlayers] = useState<readonly PlayerSetup[]>(DEFAULT_PLAYERS.slice(0, 2));
  const [seed, setSeed] = useState('POSTMAN_TEST_0042');
  const [validation, setValidation] = useState<string | null>(null);

  const changePlayer = (index: number, patch: Partial<PlayerSetup>) => {
    setPlayers((current) => current.map((player, i) => i === index ? { ...player, ...patch } : player));
    setValidation(null);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (players.some((player) => player.name.trim() === '')) {
      setValidation('Имя каждого игрока должно содержать хотя бы один символ.');
      return;
    }
    if (!seed.trim()) {
      setValidation('Укажите непустую строку исходного значения партии.');
      return;
    }
    const cleanPlayers = players.map((player) => ({
      ...player,
      name: player.name.trim(),
      color: player.color.toUpperCase() as PlayerColor,
    }));
    if (cleanPlayers.some((player) => !/^#[0-9A-F]{6}$/.test(player.color))) {
      setValidation('Укажите цвета в формате #RRGGBB.');
      return;
    }
    setValidation(null);
    onStart({ seed, players: cleanPlayers });
  };

  return (
    <main className="setup-layout" id="main-content">
      <section className="setup-intro paper-card" aria-labelledby="setup-title">
        <span className="eyebrow">Средневековая настольная летопись</span>
        <h1 id="setup-title">Земли и короны</h1>
        <div className="title-rule" aria-hidden="true">✦ ✦ ✦</div>
        <p className="lead">Возводите города, прокладывайте дороги и оставляйте след в истории новых земель.</p>
        <p>Одна доска, от двух до пяти участников, поочерёдные ходы за одним экраном.</p>
        <div className="setup-illustration" aria-hidden="true">
          <span className="illustration-rosette">✶</span>
          <span className="illustration-hill illustration-hill--back" />
          <span className="illustration-hill illustration-hill--front" />
          <span className="illustration-castle">♜</span>
          <span className="illustration-road" />
        </div>
        <div className="setup-actions">
          {hasResume && (
            <button className="btn btn--secondary" type="button" onClick={onResume} data-testid="resume-game">
              <span aria-hidden="true">↶</span> Продолжить сохранённую партию
            </button>
          )}
          <button className="btn btn--quiet" type="button" onClick={onOpenLab}>Каталог и лаборатория плиток →</button>
        </div>
      </section>

      <section className="setup-form paper-card" aria-labelledby="party-title">
        <div className="section-heading">
          <span className="eyebrow">Глава первая</span>
          <h2 id="party-title">Соберите совет</h2>
          <p>Выберите имя, цвет и герб каждого участника.</p>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="form-bar">
            <span className="form-caption">Участников</span>
            <div className="stepper" role="group" aria-label="Число игроков">
              <button type="button" aria-label="Убрать игрока" disabled={players.length <= 2}
                onClick={() => setPlayers((current) => current.slice(0, -1))}>−</button>
              <output aria-live="polite">{players.length}</output>
              <button type="button" aria-label="Добавить игрока" disabled={players.length >= 5}
                onClick={() => setPlayers((current) => [...current, DEFAULT_PLAYERS[current.length]!])}>+</button>
            </div>
          </div>
          <div className="setup-players">
            {players.map((player, index) => (
              <fieldset className="setup-player" key={index}>
                <legend>Участник {index + 1}</legend>
                <HeraldicMark symbol={player.heraldicSymbol} color={player.color} size="lg" />
                <div className="setup-player__fields">
                  <label className="form-field">
                    <span>Имя</span>
                    <input value={player.name} maxLength={40} required
                      autoComplete="off" onChange={(e) => changePlayer(index, { name: e.target.value })}
                      aria-label={'Имя участника ' + (index + 1)} />
                  </label>
                  <label className="form-field form-field--color">
                    <span>Цвет</span>
                    <input type="color" value={player.color}
                      onChange={(e) => changePlayer(index, { color: e.target.value.toUpperCase() as PlayerColor })}
                      aria-label={'Цвет участника ' + (index + 1)} />
                    <output aria-hidden="true">{player.color}</output>
                  </label>
                  <label className="form-field">
                    <span>Герб</span>
                    <select value={player.heraldicSymbol} aria-label={'Герб участника ' + (index + 1)}
                      onChange={(e) => changePlayer(index, { heraldicSymbol: e.target.value as HeraldicSymbol })}>
                      {HERALDIC_OPTIONS.map((symbol) => (
                        <option key={symbol} value={symbol}>{HERALDRY[symbol].label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
            ))}
          </div>
          <label className="form-field setup-seed">
            <span>Исходная строка для повторяемой партии</span>
            <input value={seed} onChange={(e) => { setSeed(e.target.value); setValidation(null); }}
              spellCheck={false} autoComplete="off" maxLength={160} required
              aria-describedby="seed-note" data-testid="seed-input" />
          </label>
          <p id="seed-note" className="hint">Одинаковая строка и одинаковые действия дают одинаковый порядок плиток.</p>
          {(validation || error) && <p className="notice notice--error" role="alert">{validation ?? error}</p>}
          <button type="submit" className="btn btn--primary btn--wide" data-testid="start-game">
            Начать летопись <span aria-hidden="true">↗</span>
          </button>
        </form>
      </section>
    </main>
  );
}
