import type { HeraldicSymbol, PlayerSetup } from '../game';
import { HERALDRY } from './presentation';

interface HeraldicMarkProps {
  symbol: HeraldicSymbol;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Original, silhouette-only heraldic vector pictograms with shape as well as color. */
function HeraldicPictogram({ symbol }: { symbol: HeraldicSymbol }): React.JSX.Element {
  switch (symbol) {
    case 'lion':
      return <svg viewBox="0 0 100 100" aria-hidden="true" className="heraldic-mark__symbol">
        <path fill="currentColor" d="M26 67 18 61 22 44 14 35 20 22 31 17 43 24 45 36 57 37 66 46 63 60 54 62 55 79 43 79 40 64 33 64 31 80 20 80 25 68Z" />
        <path fill="currentColor" d="M62 47Q88 51 79 27Q95 31 88 49Q85 67 65 67Z" />
        <circle cx="29" cy="30" r="3" fill="#593a29" />
        <path d="M22 41 35 40" stroke="#593a29" strokeWidth="3" strokeLinecap="round" />
      </svg>;
    case 'eagle':
      return <svg viewBox="0 0 100 100" aria-hidden="true" className="heraldic-mark__symbol">
        <path fill="currentColor" d="M50 19 40 30 13 22 19 41 29 48 12 45 25 58 38 59 38 73 50 86 62 73 62 59 75 58 88 45 71 48 81 41 87 22 60 30Z" />
        <path fill="#593a29" d="M46 29 54 29 50 40Z" />
        <path d="M31 53 44 51M69 53 56 51" stroke="#593a29" strokeWidth="3" strokeLinecap="round" />
      </svg>;
    case 'tower':
      return <svg viewBox="0 0 100 100" aria-hidden="true" className="heraldic-mark__symbol">
        <path fill="currentColor" d="M21 24 32 24 32 33 43 33 43 24 57 24 57 33 68 33 68 24 79 24 79 41 72 41 72 79 28 79 28 41 21 41Z" />
        <path fill="#593a29" d="M43 61Q50 50 57 61L57 79 43 79Z" />
        <rect fill="#593a29" x="35" y="45" width="8" height="9" rx="1" />
        <rect fill="#593a29" x="57" y="45" width="8" height="9" rx="1" />
      </svg>;
    case 'sun':
      return <svg viewBox="0 0 100 100" aria-hidden="true" className="heraldic-mark__symbol">
        <g fill="currentColor">
          <circle cx="50" cy="50" r="20" />
          <path d="M45 8H55L59 26H41ZM45 92H55L59 74H41ZM8 45V55L26 59V41ZM92 45V55L74 59V41ZM17 23 23 17 38 31 31 38ZM83 77 77 83 62 69 69 62ZM23 83 17 77 31 62 38 69ZM77 17 83 23 69 38 62 31Z" />
        </g>
      </svg>;
    case 'oak':
      return <svg viewBox="0 0 100 100" aria-hidden="true" className="heraldic-mark__symbol">
        <path fill="currentColor" d="M43 81 44 62 29 51 34 43 45 51 48 29 56 29 57 51 67 43 71 50 58 63 60 81Z" />
        <path fill="currentColor" d="M24 51Q12 48 16 34Q12 20 30 18Q37 5 51 13Q67 4 75 18Q94 16 86 35Q91 50 74 53Q68 67 53 62Q38 69 29 57Z" />
        <path d="M35 80H68" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      </svg>;
  }
}

export function HeraldicMark({ symbol, color, size = 'md', className = '' }: HeraldicMarkProps): React.JSX.Element {
  const heraldry = HERALDRY[symbol];
  return (
    <span className={'heraldic-mark heraldic-mark--' + size + ' ' + className}
      style={{ '--heraldry-color': color ?? '#8f4039' } as React.CSSProperties}
      role="img" aria-label={'Герб: ' + heraldry.label} title={'Герб: ' + heraldry.label}>
      <HeraldicPictogram symbol={symbol} />
    </span>
  );
}

export function PlayerIdentity({ player }: { player: Pick<PlayerSetup, 'name' | 'color' | 'heraldicSymbol'> }): React.JSX.Element {
  return (
    <span className="player-identity">
      <HeraldicMark symbol={player.heraldicSymbol} color={player.color} size="sm" />
      <span className="player-identity__text">{player.name}</span>
      <span className="sr-only">Герб: {HERALDRY[player.heraldicSymbol].label}</span>
    </span>
  );
}
