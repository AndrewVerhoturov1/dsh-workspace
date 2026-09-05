/** Path-encoded HTML preview routes, with an optional encoded worktree root. */
export interface HtmlRouteRef {
  sessionId: string
  path: string
  workspaceRoot?: string
}

export type HtmlDecodeResult =
  | { ok: true; ref: HtmlRouteRef }
  | { ok: false; status: 400 | 404; message: string }

export const HTML_ROUTE_PREFIX = '/sidebar/html/'
export const HTML_WORKSPACE_ROUTE_PREFIX = '/sidebar/workspace-html/'

function encodedPath(path: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  const segments = path.split(/[\\/]+/).filter(segment => segment !== '')
  return `${unc ? '/' : ''}${segments.map(encodeURIComponent).join('/')}`
}

export function encodeHtmlUrl(sessionId: string, path: string, workspaceRoot?: string): string {
  if (workspaceRoot === undefined || workspaceRoot === '') {
    return `${HTML_ROUTE_PREFIX}${encodeURIComponent(sessionId)}/${encodedPath(path)}`
  }
  return `${HTML_WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(workspaceRoot)}/${encodedPath(path)}`
}

type RebuiltPath = { ok: true; path: string } | { ok: false; status: 400 | 404; message: string }

function rebuildPath(segments: string[]): RebuiltPath {
  const unc = segments[0] === ''
  const tail = unc ? segments.slice(1) : segments
  if (tail.length === 0 || tail.some(segment => segment === '')) {
    return { ok: false, status: 400, message: 'sessionId and file path are required' }
  }
  if (unc) return { ok: true, path: `//${tail.join('/')}` }
  if (/^[A-Za-z]:$/.test(tail[0] ?? '')) return { ok: true, path: tail.join('/') }
  return { ok: true, path: `/${tail.join('/')}` }
}

export function decodeHtmlUrl(pathname: string): HtmlDecodeResult {
  const workspace = pathname.startsWith(HTML_WORKSPACE_ROUTE_PREFIX)
  const legacy = pathname.startsWith(HTML_ROUTE_PREFIX)
  if (!workspace && !legacy) return { ok: false, status: 404, message: 'not an html route' }
  const prefix = workspace ? HTML_WORKSPACE_ROUTE_PREFIX : HTML_ROUTE_PREFIX
  const rest = pathname.slice(prefix.length)
  if (rest === '') return { ok: false, status: 400, message: 'invalid html route path' }
  let segments: string[]
  try {
    segments = rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return { ok: false, status: 400, message: 'malformed URL encoding' }
  }
  const sessionId = segments.shift()
  if (sessionId === undefined || sessionId === '') return { ok: false, status: 400, message: 'sessionId and file path are required' }
  let workspaceRoot: string | undefined
  if (workspace) {
    workspaceRoot = segments.shift()
    if (workspaceRoot === undefined || workspaceRoot === '') return { ok: false, status: 400, message: 'workspace root is required' }
  }
  const rebuilt = rebuildPath(segments)
  if (!rebuilt.ok) return rebuilt
  return { ok: true, ref: { sessionId, path: rebuilt.path, ...(workspaceRoot !== undefined ? { workspaceRoot } : {}) } }
}
