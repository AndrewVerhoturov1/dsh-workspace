import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createGame, exportSave, getTileCatalog, restoreSave, transition,
} from '../game';
import type { CreateGameInput, GameCommand, GameEvent, GameState, TileCatalog } from '../game';
import { GameScreen } from './GameScreen';
import { SaveLoad } from './SaveLoad';
import { SetupScreen } from './SetupScreen';
import { TileLab } from './TileLab';
import type { EventLogEntry } from './Scoreboard';
import './styles.css';

type Page = 'setup' | 'game' | 'tile-lab';
const LOCAL_SAVE_KEY = 'lands-and-crowns.saved-game.v1';

function pageFromLocation(): Page {
  const path = window.location.pathname;
  if (/\/tile-lab\/?$/.test(path)) return 'tile-lab';
  if (/\/game\/?$/.test(path)) return 'game';
  return 'setup';
}

function pagePath(page: Page): string {
  const pathname = window.location.pathname;
  const base = pathname.replace(/\/(?:game|tile-lab)\/?$/, '/').replace(/\/?$/, '/');
  return page === 'setup' ? base : base + page;
}

function savedOnDevice(): string | null {
  try {
    return window.localStorage.getItem(LOCAL_SAVE_KEY);
  } catch {
    return null;
  }
}

function storeOnDevice(json: string): string | null {
  try {
    window.localStorage.setItem(LOCAL_SAVE_KEY, json);
    return null;
  } catch {
    return 'Не удалось записать местное сохранение. Используйте «Скачать JSON», чтобы не потерять партию.';
  }
}

function forgetOnDevice(): void {
  try {
    window.localStorage.removeItem(LOCAL_SAVE_KEY);
  } catch {
    // Storage is optional; a failed removal must not block a fresh game.
  }
}

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>(pageFromLocation);
  const [game, setGame] = useState<GameState | null>(null);
  const gameRef = useRef<GameState | null>(null);
  const [catalog, setCatalog] = useState<TileCatalog | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<string | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(savedOnDevice);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [logs, setLogs] = useState<readonly EventLogEntry[]>([]);
  const nextEventId = useRef(0);
  const [confirmNew, setConfirmNew] = useState(false);
  const [pendingStart, setPendingStart] = useState<CreateGameInput | null>(null);
  const confirmationRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      setCatalog(getTileCatalog());
      setCatalogFailure(null);
    } catch (cause) {
      setCatalogFailure('Не удалось открыть каталог игрового движка: ' +
        (cause instanceof Error ? cause.message : String(cause)));
    }
  }, []);

  useEffect(() => {
    const onNavigation = () => setPage(pageFromLocation());
    window.addEventListener('popstate', onNavigation);
    return () => window.removeEventListener('popstate', onNavigation);
  }, []);

  useEffect(() => {
    if (!confirmNew) return;
    confirmationRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfirmNew(false);
        setPendingStart(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmNew]);

  useEffect(() => {
    if (!game) return;
    try {
      const json = exportSave(game);
      const warning = storeOnDevice(json);
      if (!warning) setSavedJson(json);
      setStorageWarning(warning);
    } catch (cause) {
      setStorageWarning('Автосохранение отклонено игровым движком: ' +
        (cause instanceof Error ? cause.message : String(cause)));
    }
  }, [game]);

  const goTo = useCallback((next: Page) => {
    const destination = pagePath(next);
    if (window.location.pathname !== destination) {
      window.history.pushState({ page: next }, '', destination);
    }
    setPage(next);
    setError(null);
    setStatus(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const beginSession = useCallback((input: CreateGameInput) => {
    try {
      const created = createGame(input);
      gameRef.current = created;
      setGame(created);
      setLogs([]);
      nextEventId.current = 0;
      setError(null);
      goTo('game');
      setStatus('Новая партия создана. Первый ход определён игровым движком.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось создать партию.');
    }
  }, [goTo]);

  const requestStart = (input: CreateGameInput) => {
    if (gameRef.current) {
      setPendingStart(input);
      setConfirmNew(true);
      return;
    }
    beginSession(input);
  };

  const loadJson = useCallback((json: string, origin: 'file' | 'local') => {
    try {
      const restored = restoreSave(json);
      if (!restored.ok) {
        setError('Сохранение не принято (' + restored.error.code + '): ' +
          restored.error.message + (restored.error.detail ? ' ' + restored.error.detail : ''));
        setStatus(null);
        return;
      }
      gameRef.current = restored.state;
      setGame(restored.state);
      setLogs([]);
      nextEventId.current = 0;
      setError(null);
      goTo('game');
      setStatus(origin === 'local'
        ? 'Местная партия восстановлена и проверена повторным воспроизведением команд.'
        : 'Партия из файла проверена и восстановлена.');
    } catch (cause) {
      setError('Не удалось прочитать сохранение: ' +
        (cause instanceof Error ? cause.message : String(cause)));
      setStatus(null);
    }
  }, [goTo]);

  const performCommand = useCallback((command: GameCommand) => {
    const current = gameRef.current;
    if (!current || current.phase === 'finished') return;
    try {
      const result = transition(current, command);
      if (!result.ok) {
        setError(result.error.message + ' (' + result.error.code + ')');
        setStatus(null);
        return;
      }
      gameRef.current = result.state;
      setGame(result.state);
      setError(null);
      setStatus(null);
      if (result.events.length) {
        const batch = result.events.map((event: GameEvent): EventLogEntry => ({
          id: 'event-' + (++nextEventId.current),
          turn: current.turn,
          event,
        }));
        setLogs((previous) => [...previous, ...batch].slice(-100));
      }
    } catch (cause) {
      setError('Ход не выполнен: ' + (cause instanceof Error ? cause.message : String(cause)));
    }
  }, []);

  const downloadSave = useCallback(() => {
    const current = gameRef.current;
    if (!current) return;
    try {
      const json = exportSave(current);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'zemli-i-korony-' + current.seed.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) + '.json';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 800);
      setError(null);
      setStatus('Файл сохранения подготовлен браузером.');
    } catch (cause) {
      setStatus(null);
      setError('Не удалось экспортировать партию: ' +
        (cause instanceof Error ? cause.message : String(cause)));
    }
  }, []);

  const requestRestart = useCallback(() => {
    if (gameRef.current) {
      setPendingStart(null);
      setConfirmNew(true);
    } else goTo('setup');
  }, [goTo]);

  const confirmRestart = () => {
    const nextGame = pendingStart;
    setConfirmNew(false);
    setPendingStart(null);
    if (nextGame) {
      beginSession(nextGame);
    } else {
      gameRef.current = null;
      setGame(null);
      setLogs([]);
      nextEventId.current = 0;
      setSavedJson(null);
      setStorageWarning(null);
      forgetOnDevice();
      goTo('setup');
    }
  };

  const activePage = page === 'game' && !game ? 'setup' : page;

  return (
    <div className="application">
      <a href="#main-content" className="skip-link">Перейти к основному содержимому</a>
      <header className="site-header">
        <div className="site-header__inner">
          <button type="button" className="site-brand" onClick={() => goTo(game ? 'game' : 'setup')}
            aria-label="Земли и короны — к партии">
            <span className="site-brand__crest" aria-hidden="true">✣</span>
            <span><strong>Земли и короны</strong><small>настольная летопись</small></span>
          </button>
          <nav className="site-nav" aria-label="Разделы">
            <button type="button" className={activePage === 'game' ? 'is-active' : ''}
              onClick={() => goTo(game ? 'game' : 'setup')}>{game ? 'К партии' : 'Главная'}</button>
            <button type="button" className={page === 'tile-lab' ? 'is-active' : ''}
              onClick={() => goTo('tile-lab')}>Лаборатория плиток</button>
          </nav>
          <span className="site-header__edition">Базовый набор · 72 плитки</span>
        </div>
      </header>

      {catalogFailure && (
        <div className="system-notice notice notice--error" role="alert">
          {catalogFailure}. Игровой модуль должен предоставить каталог и функции по CONTRACT.md.
        </div>
      )}
      {storageWarning && <div className="system-notice notice notice--warning" role="alert">{storageWarning}</div>}

      {catalog ? (
        <>
          {activePage === 'setup' && (
            <>
              <SetupScreen
                onStart={requestStart}
                onOpenLab={() => goTo('tile-lab')}
                onResume={() => { if (savedJson) loadJson(savedJson, 'local'); }}
                hasResume={Boolean(savedJson)}
                error={error}
              />
              <section className="setup-import paper-card" aria-label="Загрузка сохранения из файла">
                <p>Уже играли? Можно восстановить партию из JSON-файла, даже если местная копия недоступна.</p>
                <SaveLoad canSave={false} onDownload={downloadSave}
                  onImportText={(text) => loadJson(text, 'file')} />
              </section>
            </>
          )}

          {activePage === 'game' && game && (
            <GameScreen
              game={game} definitions={catalog.definitions}
              logs={logs} error={error} status={status}
              onCommand={performCommand} onDownload={downloadSave}
              onImportText={(text) => loadJson(text, 'file')}
              onRestart={requestRestart} onOpenLab={() => goTo('tile-lab')}
            />
          )}

          {activePage === 'tile-lab' && (
            <TileLab catalog={catalog} onBack={() => goTo(game ? 'game' : 'setup')} />
          )}
        </>
      ) : (
        <main className="startup-status paper-card" id="main-content" role="status">
          <h1>Открытие каталога</h1>
          <p>{catalogFailure
            ? 'Не удалось запустить игровой модуль. При подключении игровой реализации повторите загрузку страницы.'
            : 'Чтение подлинных определений плиток из игрового движка.'}</p>
        </main>
      )}

      <footer className="site-footer">
        <span>Земли и короны · оригинальная процедурная настольная сцена</span>
        <span>Ходы и очки определяет игровой движок · Управление мышью и клавиатурой</span>
      </footer>

      {confirmNew && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setConfirmNew(false);
            setPendingStart(null);
          }
        }}>
          <section className="confirm-modal paper-card" role="alertdialog" aria-modal="true"
            aria-labelledby="new-game-confirm-title" aria-describedby="new-game-confirm-desc">
            <span className="eyebrow">Подтверждение</span>
            <h2 id="new-game-confirm-title">Начать другую партию?</h2>
            <p id="new-game-confirm-desc">
              Текущая партия будет заменена. Её можно сохранить в JSON до начала новой. Это действие нельзя отменить.
            </p>
            <div className="confirm-modal__actions">
              <button ref={confirmationRef} className="btn btn--secondary" type="button"
                onClick={() => { setConfirmNew(false); setPendingStart(null); }}>Продолжить текущую</button>
              <button className="btn btn--danger" type="button" onClick={confirmRestart}
                data-testid="confirm-restart">Да, начать новую</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
