/**
 * Pure URL policy for the built-in browser tab: normalize user input into
 * an http(s) URL, and refuse destinations that would be dangerous to embed
 * in the sidebar iframe. Kept dependency-free so it is unit-testable.
 *
 * The iframe sandbox (no top-navigation and no GUI same-origin access)
 * is the primary security boundary; this module is the address-bar gate on
 * top of it: only http/https may be navigated, and loopback addresses are
 * refused so a browsed page cannot probe local services by user action. The
 * sandbox keeps the visited page's own origin (`allow-same-origin`) so
 * ordinary pages do not lose their same-origin/CORS behavior; the parent GUI
 * remains a different origin.
 */

/** Why a navigation attempt was refused. */
export type BrowserBlockReason = 'scheme' | 'loopback'

/** Result of normalizing one address-bar input. */
export type BrowserNavigateResult =
  | { kind: 'ok'; url: string }
  | { kind: 'blocked'; reason: BrowserBlockReason }
  | { kind: 'invalid' }

/** One browser.probe wire result (host fetch of the target's headers). */
export interface BrowserProbeResult {
  reachable: boolean
  /** The final (post-redirect) URL; present when reachable. */
  url?: string
  status?: number
  xFrameOptions?: string
  /** The CSP frame-ancestors source list; present when the directive exists. */
  frameAncestors?: string[]
}

/** Embeddability verdict of one probe. */
export type Embeddability = 'embeddable' | 'blocked' | 'unknown'

/**
 * Decide whether a site can render inside the sidebar iframe. The signals
 * are exactly the ones the BROWSER enforces when it refuses an iframe load:
 * X-Frame-Options DENY/SAMEORIGIN, or a frame-ancestors directive that does
 * not allow `*` ('self' here means the SITE's own origin — never ours, so
 * it also blocks the sidebar). A site we could not reach yields 'unknown'
 * and the plain iframe stays.
 */
export function embeddabilityOf(probe: BrowserProbeResult): Embeddability {
  if (probe.reachable !== true) return 'unknown'
  const xfo = probe.xFrameOptions?.trim().toUpperCase()
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return 'blocked'
  if (probe.frameAncestors !== undefined && !probe.frameAncestors.some(source => source === '*')) return 'blocked'
  return 'embeddable'
}

/** A loopback hostname (localhost, IPv6 ::1, 127.0.0.0/8, 0.0.0.0). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Normalize one address-bar input against the navigation policy.
 * @param input - raw user text.
 * @param selfOrigin - retained for the caller's existing API shape. The GUI's
 * own origin is not exempt from the loopback gate: allowing it would put a
 * same-origin page inside the sidebar and defeat the browser isolation.
 */
/** Schemes that must never reach the iframe, even without `//` (javascript:,
 *  data:, file:, ...). Host:port lookalikes (example.com:8080) are NOT here —
 *  they parse as hosts below. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript', 'data', 'file', 'about', 'vbscript', 'blob',
  'mailto', 'tel', 'ftp', 'ftps', 'ws', 'wss', 'sftp', 'ssh',
  'chrome', 'chrome-extension', 'moz-extension', 'edge', 'opera', 'resource', 'view-source',
])

export function normalizeBrowserUrl(input: string, selfOrigin: string): BrowserNavigateResult {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'invalid' }
  // Distinguish an explicit scheme from a bare host:port. "example.com:8080"
  // would match a naive scheme regex (dots are legal in schemes), so a
  // scheme prefix is only honored when it is http(s) or a known-forbidden
  // scheme; anything else is treated as a host and gets https://.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  let withScheme: string
  if (schemeMatch === null) {
    withScheme = `https://${trimmed}`
  } else {
    const scheme = schemeMatch[1]!.toLowerCase()
    if (scheme === 'http' || scheme === 'https') withScheme = trimmed
    else if (FORBIDDEN_SCHEMES.has(scheme)) return { kind: 'blocked', reason: 'scheme' }
    else withScheme = `https://${trimmed}`
  }
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { kind: 'invalid' }
  }
  // The protocol backstop: any URL that still parses to a non-http(s)
  // scheme (e.g. ftp://, ws:// — which carry `//` and skip the list) is
  // refused here.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', reason: 'scheme' }
  // `selfOrigin` is intentionally not an allow-list entry. Even the GUI's
  // own loopback origin must stay blocked: with allow-same-origin on the
  // sandboxed iframe, it would otherwise regain access to the GUI origin.
  void selfOrigin
  if (isLoopbackHostname(url.hostname)) return { kind: 'blocked', reason: 'loopback' }
  return { kind: 'ok', url: url.href }
}
