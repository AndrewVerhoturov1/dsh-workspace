import type { SidebarPrefs } from '../prefs-shared.ts'
import { api } from './api.ts'

const MARKER = 'dsh-better-sidebar-andrew:browser-policy:v1'

/** One-time revision-guarded migration of only the three browser switches. */
export async function ensureAndrewBrowserPolicy(): Promise<void> {
  try {
    if (localStorage.getItem(MARKER) === '1') return
  } catch {
    // Continue with an idempotent guarded write when storage is unavailable.
  }
  const current = await api.settingsGet()
  const prefs = current.value !== null && typeof current.value === 'object'
    ? current.value as Partial<SidebarPrefs>
    : {}
  if (prefs.browserInterceptLinks !== true || prefs.browserInterceptHttp !== true || prefs.browserInterceptHttps !== true) {
    await api.settingsUpdate({ browserInterceptLinks: true, browserInterceptHttp: true, browserInterceptHttps: true }, current.revision)
  }
  try { localStorage.setItem(MARKER, '1') } catch { /* retry on a later activation */ }
}
