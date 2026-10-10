import type { Command, InventoryEntry, ItemDef, ServerEvent } from '@questline/schema'
import type { PluginOptions } from 'claude-code'
import type { BandView, Tier } from '../types'
import { tierOf } from './celebrate'
import { capitalised } from './frames'

// Dev mode, for trying the game out: which server the mod talks to, what `/questline dev …` asks for, the commands
// a dev server takes, and the stand-in events a celebration preview plays. Only a dev server runs the commands; the
// mod shows its dev controls only when the snapshot says it talks to one.

/** The `server` option: the player's own save, or the dev sandbox (`QUESTLINE_DEV=1`, in `~/.questline-dev`). */
export type ServerKind = 'default' | 'dev'

export const serverOf = (options: PluginOptions): ServerKind => (options['server'] === 'dev' ? 'dev' : 'default')

/** How to start the server the mod looks for. */
export const startHint = (server: ServerKind): string =>
  server === 'dev' ? 'QUESTLINE_DEV=1 pnpm --filter @questline/server start' : 'pnpm --filter @questline/server start'

/** What a celebration preview plays: a drop of a tier, a level-up, or an XP gain. */
export type Preview = Tier | 'levelup' | 'xp'

/** One thing dev mode can do. */
export type DevAsk =
  | { kind: 'styles' }
  | { kind: 'item'; itemId: string }
  | { kind: 'xp'; amount: number }
  | { kind: 'gold'; gold: number }
  | { kind: 'celebrate'; what: Preview }

export const devUsage =
  'Dev mode: /questline dev styles | item <id> | xp <amount> | gold <amount> | ' +
  'celebrate <common|uncommon|rare|epic|legendary|levelup|xp>'

/** Every preview, in the order the pane offers them. */
export const previews: ReadonlyArray<Preview> = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'levelup', 'xp']

const wholeOf = (text: string | undefined, least: number): number | null => {
  const value = text === undefined || !/^\d+$/.test(text) ? Number.NaN : Number(text)
  return Number.isSafeInteger(value) && value >= least ? value : null
}

/**
 * What `/questline <args>` asks dev mode for: null when the args are not `dev …`, a usage line when they don't
 * parse.
 */
export const devAskOf = (args: string): DevAsk | string | null => {
  const [head, what, value, ...rest] = args.trim().split(/\s+/)
  if (head !== 'dev') return null
  if (rest.length > 0) return devUsage
  switch (what) {
    case 'styles':
      return value === undefined ? { kind: 'styles' } : devUsage
    case 'item':
      return value === undefined ? devUsage : { kind: 'item', itemId: value }
    case 'xp': {
      const amount = wholeOf(value, 1)
      return amount === null ? devUsage : { kind: 'xp', amount }
    }
    case 'gold': {
      const gold = wholeOf(value, 0)
      return gold === null ? devUsage : { kind: 'gold', gold }
    }
    case 'celebrate': {
      const preview = previews.find((one) => one === value)
      return preview === undefined ? devUsage : { kind: 'celebrate', what: preview }
    }
    default:
      return devUsage
  }
}

/** The dev command a dev server runs for `ask`; a celebration preview runs in the mod alone. */
export const devCommandOf = (ask: DevAsk, id: string): Command | null => {
  switch (ask.kind) {
    case 'styles':
      return { id, type: 'dev.grantStyles', data: {} }
    case 'item':
      return { id, type: 'dev.grantItem', data: { itemId: ask.itemId } }
    case 'xp':
      return { id, type: 'dev.grantXp', data: { amount: ask.amount } }
    case 'gold':
      return { id, type: 'dev.setGold', data: { gold: ask.gold } }
    case 'celebrate':
      return null
  }
}

/** XP that takes the character just over the next level. */
export const toNextLevel = (view: BandView): number => Math.max(1, view.xp.forNextLevel - view.xp.intoLevel)

type XpData = Extract<ServerEvent, { type: 'xp.granted' }>['data']
type LevelData = Extract<ServerEvent, { type: 'level.up' }>['data']

/**
 * The stand-in events a preview plays, as if the server had sent them, under one made-up cause: the band, the gain
 * and the toast take them as they would real ones. Nothing reaches the server.
 */
export const previewEvents = (what: Preview, view: BandView, at: string, cause: string): Array<ServerEvent> => {
  const base = { seq: 0, at, cause }
  if (what === 'xp') {
    const data = { amount: 20, tier: 'reported', reason: 'dev', totalAfter: view.xp.total + 20 } satisfies XpData
    return [{ ...base, type: 'xp.granted', data }]
  }
  if (what === 'levelup') {
    const data = { from: view.level, to: view.level + 1, tier: 'rare', glyph: view.glyph } satisfies LevelData
    return [{ ...base, type: 'level.up', data }]
  }
  const tier = tierOf(what)
  const item: ItemDef = {
    id: 'dev-preview',
    name: `${capitalised(tier)} Preview`,
    rarity: tier,
    category: 'artefact',
    slot: null,
    sprite: null,
    lore: null,
    effect: null,
    look: null,
  }
  const source = { kind: 'dev', ref: 'preview' } satisfies InventoryEntry['source']
  const entry: InventoryEntry = { id: cause, itemId: item.id, acquiredAt: at, source, dye: null }
  const pity = { sinceRare: 0, sinceEpic: 0 }
  return [{ ...base, type: 'loot.dropped', data: { entry, item, gold: 0, pity, tier } }]
}
