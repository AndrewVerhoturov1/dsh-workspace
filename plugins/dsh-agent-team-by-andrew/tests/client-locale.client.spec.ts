import { describe, expect, it } from 'vitest'
import { ClientI18n, DICTIONARIES, type MessageKey } from '../src/client/i18n.ts'

describe('Russian UI dictionary', () => {
  it('contains every upstream UI key and keeps the internal placeholders', () => {
    const upstreamKeys = Object.keys(DICTIONARIES.en).sort()
    const russianKeys = Object.keys(DICTIONARIES.ru).sort()
    expect(russianKeys).toEqual(upstreamKeys)

    for (const key of upstreamKeys as MessageKey[]) {
      const placeholders = DICTIONARIES.en[key].match(/\{\w+\}/g) ?? []
      expect(DICTIONARIES.ru[key].match(/\{\w+\}/g) ?? []).toEqual(placeholders)
    }
  })

  it('uses Russian text only when the Andrew browser entry opts in', () => {
    expect(new ClientI18n(undefined, true).t('teams')).toBe('Команды')
    expect(new ClientI18n().t('teams')).toBe('小队')
  })
})
