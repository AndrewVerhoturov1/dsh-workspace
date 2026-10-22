import { useRef, useState } from 'react';

interface SaveLoadProps {
  canSave: boolean;
  onDownload: () => void;
  onImportText: (text: string) => void;
  compact?: boolean;
}

/** File transport only. The engine owns validation, replay and schema. */
export function SaveLoad({
  canSave, onDownload, onImportText, compact = false,
}: SaveLoadProps): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 2_000_000) {
      setReadError('Файл слишком велик для сохранения партии (максимум 2 МБ).');
      return;
    }
    try {
      const text = await file.text();
      setReadError(null);
      onImportText(text);
    } catch {
      setReadError('Не удалось прочитать выбранный файл.');
    }
  };

  return (
    <div className={'save-load' + (compact ? ' save-load--compact' : '')}>
      {canSave && (
        <button type="button" className="btn btn--secondary" onClick={onDownload} data-testid="save-game"
          title="Сохранение по версии 1 через игровой движок">↓ Скачать JSON</button>
      )}
      <input
        ref={fileRef} type="file" accept=".json,application/json,text/plain"
        className="sr-only" tabIndex={-1} aria-label="Файл сохранённой партии"
        onChange={(event) => { void importFile(event); }}
      />
      <button type="button" className="btn btn--quiet" data-testid="load-game"
        onClick={() => { setReadError(null); fileRef.current?.click(); }}>
        ↑ Загрузить JSON
      </button>
      {readError && <p className="notice notice--error" role="alert">{readError}</p>}
    </div>
  );
}
