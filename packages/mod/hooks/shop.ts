import type { RulesConfig, Snapshot } from '@pathofdev/schema'
import type {
  BandLook,
  BandSlot,
  CareView,
  CraftView,
  FoodView,
  MealView,
  OfferView,
  ShopView,
  SpareView,
  Tier,
} from '../types'
import { happyLine, heartsFor, knowsCareOf, moodWord } from './care'
import { boostText, foodOf, tierOf, tierRank } from './celebrate'
import type { Row, Run } from './cells'
import { blank, cellsOf, cellsOfRow, clip, dim } from './cells'
import { rarityColors } from './frames'
import { bandSlots } from './looks'
import { sectionTitle } from './missions'
import { kindOf } from './pane'
import { counted, fitting, meter } from './stats'

// The pane's Shop tab and the pet's card, as rows of styled runs that register.tsx draws with its buttons beside them.
// The server sets every price, stock and mood; this file reads the snapshot and the rules beside it, and says what
// they mean in plain words. Nothing here nags: a low mood reads as sleepy, never sad, and nothing is lost.

const tiers: ReadonlyArray<Tier> = ['common', 'uncommon', 'rare', 'epic', 'legendary']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const numberOr = <A,>(value: unknown, fallback: A): number | A =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const instantOf = (iso: unknown): number | null => {
  const at = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/** Whether the server keeps a shop: only one whose rules carry it does. */
export const knowsShopOf = (rules: Partial<RulesConfig>): boolean => isRecord(rules.shop)

/** The rules' number for a rarity, read with care. */
const byRarity = (record: unknown, rarity: Tier): number | null =>
  isRecord(record) ? numberOr(record[rarity], null) : null

/** The Shop tab's view of the snapshot: today's offers, the spare copies, the shards and what they can make. */
export const shopViewOf = (snapshot: Snapshot, rules: Partial<RulesConfig>): ShopView => {
  const defs = Array.isArray(snapshot.items) ? snapshot.items : []
  const byId = new Map(defs.map((def) => [def.id, def]))
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : []
  const copies = new Map<string, number>()
  for (const entry of inventory) copies.set(entry.itemId, (copies.get(entry.itemId) ?? 0) + 1)
  const offers = (Array.isArray(snapshot.shop) ? snapshot.shop : []).flatMap((offer): Array<OfferView> => {
    const def = byId.get(offer.itemId)
    const food = def === undefined ? undefined : foodOf(def)
    // Gold never buys XP: an offer of XP food or a sigil, from a server before treats, is not shown to buy.
    if (def === undefined || isXpFood(food) || def.sigil !== undefined) return []
    return [
      {
        offerId: offer.offerId,
        itemId: def.id,
        name: def.name,
        rarity: tierOf(def.rarity),
        category: def.category,
        slot: def.slot,
        look: def.look ?? null,
        lore: def.lore,
        price: numberOr(offer.price, 0),
        stock: typeof offer.stock === 'number' ? offer.stock : null,
        endsAt: instantOf(offer.endsAt),
        owned: copies.get(def.id) ?? 0,
        ...(food === undefined ? {} : { food }),
      },
    ]
  })
  // A spare copy is one not worn: trading in the one worn would take the look off. The latest such copy goes.
  const worn = new Set(
    [...Object.values(snapshot.character.equipped ?? {}), ...Object.values(snapshot.pet?.equipped ?? {})].filter(
      (id) => typeof id === 'string',
    ),
  )
  const latestSpare = new Map<string, string>()
  for (const entry of inventory) if (!worn.has(entry.id)) latestSpare.set(entry.itemId, entry.id)
  // Food is eaten, never traded in: the server refuses a spare meal.
  const spares = [...copies.entries()].flatMap(([itemId, count]): Array<SpareView> => {
    const def = byId.get(itemId)
    const spare = latestSpare.get(itemId)
    if (count < 2 || def === undefined || spare === undefined || def.category === 'food') return []
    const rarity = tierOf(def.rarity)
    return [
      {
        itemId,
        name: def.name,
        rarity,
        category: def.category,
        slot: def.slot,
        copies: count,
        entryId: spare,
        rerollGold: byRarity(rules.loot?.rerollGold, rarity),
        salvageShards: byRarity(rules.loot?.salvageShards, rarity),
      },
    ]
  })
  spares.sort((a, b) => tierRank(b.rarity) - tierRank(a.rarity) || a.name.localeCompare(b.name))
  const held: unknown = snapshot.character.shards
  const shards = tiers.map((rarity) => ({ rarity, count: byRarity(held, rarity) ?? 0 }))
  const shardsToCraft = numberOr(rules.loot?.shardsToCraft, null)
  const enough = new Set(
    shards.filter((one) => shardsToCraft !== null && one.count >= shardsToCraft).map((one) => one.rarity),
  )
  // Shards never make what would buy XP: a sigil or XP food.
  const craftable = defs
    .filter((def) => def.sigil === undefined && !isXpFood(foodOf(def)) && enough.has(tierOf(def.rarity)))
    .map(
      (def): CraftView => ({
        itemId: def.id,
        name: def.name,
        rarity: tierOf(def.rarity),
        category: def.category,
        slot: def.slot,
        owned: copies.get(def.id) ?? 0,
      }),
    )
    .sort((a, b) => tierRank(a.rarity) - tierRank(b.rarity) || a.name.localeCompare(b.name))
  return {
    isKnown: knowsShopOf(rules),
    gold: numberOr(snapshot.character.gold, 0),
    offers,
    spares,
    shards,
    shardsToCraft,
    craftable,
  }
}

/** The pet's card's view: what lifts its mood, the food owned, and the food boost running at clock `now`. */
export const careViewOf = (snapshot: Snapshot, rules: Partial<RulesConfig>, now: number): CareView => {
  const defs = Array.isArray(snapshot.items) ? snapshot.items : []
  const byId = new Map(defs.map((def) => [def.id, def]))
  const inventory = Array.isArray(snapshot.inventory) ? snapshot.inventory : []
  const meals = new Map<string, MealView>()
  for (const entry of inventory) {
    const def = byId.get(entry.itemId)
    const food = def === undefined ? undefined : foodOf(def)
    if (def === undefined || food === undefined) continue
    const seen = meals.get(def.id)
    meals.set(def.id, {
      entryId: seen?.entryId ?? entry.id,
      itemId: def.id,
      name: def.name,
      rarity: tierOf(def.rarity),
      copies: (seen?.copies ?? 0) + 1,
      food,
      lore: def.lore,
    })
  }
  const boost = (Array.isArray(snapshot.boosts) ? snapshot.boosts : [])
    .filter((one) => one.kind === 'food')
    .map((one) => ({ pct: numberOr(one.xpBoostPct, 0), endsAt: instantOf(one.endsAt) ?? 0 }))
    .filter((one) => one.endsAt > now && one.pct > 0)
    .reduce<CareView['boost']>((best, one) => (best === null || one.pct > best.pct ? one : best), null)
  const care: unknown = rules.pet?.care
  const read = (key: string): number | null => (isRecord(care) ? numberOr(care[key], null) : null)
  return {
    isKnown: knowsCareOf(rules),
    happyAbove: numberOr(rules.pet?.happyAbove, null),
    happyBonus: numberOr(rules.pet?.happyXpBonusPct, null),
    fed: read('fed'),
    petted: read('petted'),
    pettedPerHour: read('pettedPerHour'),
    meals: [...meals.values()].sort((a, b) => tierRank(a.rarity) - tierRank(b.rarity) || a.name.localeCompare(b.name)),
    boost,
  }
}

/** Whether food boosts XP when eaten: XP food, which comes only from play. A treat (null) only lifts the mood. */
export const isXpFood = (food: FoodView | undefined): food is NonNullable<FoodView> =>
  food !== undefined && food !== null

/**
 * What a meal does, in words: `+30 mood` for a treat, `+30 mood · +10% XP for 1h` for XP food; the mood left out when
 * the rules don't say.
 */
export const foodText = (food: FoodView | undefined, fed: number | null): string =>
  [...(fed === null || fed <= 0 ? [] : [`+${counted(fed)} mood`]), ...(isXpFood(food) ? [boostText(food)] : [])].join(
    ' · ',
  )

/** Minutes left, in its two largest units: `1h 5m`, `42m`. */
const leftText = (ms: number): string => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

const goldText = (gold: number): string => `◈ ${counted(gold)}`
const goldRun = (gold: number): Run => ({ text: goldText(gold), color: 'warning', bold: true })

// The Shop tab.

/** What a row offers: a button (its label, and the command it sends), or a dim note in its place. */
export type ShopAction =
  | { kind: 'buy'; offerId: string; label: string }
  | { kind: 'reroll'; entryId: string; label: string }
  | { kind: 'salvage'; entryId: string; label: string }
  | { kind: 'craft'; rarity: Tier; itemId: string; label: string }
  | { kind: 'note'; row: Row }

/** One row of the tab: its head beside its actions, then its details, and a live preview for a band style. */
export type ShopEntry = {
  key: string
  head: Row
  actions: ReadonlyArray<ShopAction>
  details: ReadonlyArray<Row>
  preview: { slot: BandSlot; look: BandLook | null } | null
  lore: string | null
}

/** A titled part of the tab: rows of its own (the shard bars), its entries, or a line saying why there are none. */
export type ShopSection = {
  key: string
  title: Row
  rows: ReadonlyArray<Row>
  entries: ReadonlyArray<ShopEntry>
  empty: Row | null
}

export type ShopLayout = { intro: Row; note: Row | null; width: number; sections: ReadonlyArray<ShopSection> }

/** The widest the tab lays its rows out. */
const maxWidth = 72
/** Cells a row is set in from the tab's edge, and its details from its head. */
export const entryIndent = 2
export const detailIndent = 4

/** Cells a button draws, `[ label ]`, with the row's gap of 2 before it. */
const buttonCells = (label: string): number => cellsOf(label) + 4 + 2

const actionCells = (actions: ReadonlyArray<ShopAction>): number =>
  actions.reduce(
    (sum, action) => sum + (action.kind === 'note' ? cellsOfRow(action.row) + 2 : buttonCells(action.label)),
    0,
  )

/**
 * The room a head has beside `taken` cells of buttons on a row `width` wide, from `indent`: when they leave less than
 * its name, the head takes the row and the buttons wrap under it.
 */
const roomBeside = (name: string, taken: number, width: number, indent: number): number => {
  const whole = width - indent
  const beside = whole - taken
  return beside >= cellsOf(name) + 2 ? beside : whole
}

/** A section's title with the first of `rights` that leaves its rule room, or none. */
const titled = (title: string, rights: ReadonlyArray<string>, width: number): Row =>
  sectionTitle(title, rights.find((right) => width - cellsOf(title) - cellsOf(right) - 3 >= 3) ?? '', width)

/**
 * An item's head: its rarity's mark and its name in its color, then what it is, cut to `room`: the notes give way
 * from the last, then the name is cut.
 */
const headOf = (name: string, rarity: Tier, notes: ReadonlyArray<string>, room: number): Row => {
  const color = rarityColors[rarity]
  const named: Row = [{ text: '◆', color }, { text: ` ${name}`, color, bold: true }]
  const kept = notes.filter((note) => note !== '')
  const tries = kept.map((_, i): Row => [...named, dim(`  ${kept.slice(0, kept.length - i).join(' · ')}`)])
  return fitting([...tries, named], room)
}

const ownedNote = (owned: number): string => (owned === 0 ? '' : owned === 1 ? 'owned' : `${owned} owned`)

const slotOf = (slot: string | null): BandSlot | undefined => bandSlots.find((one) => one === slot)

/** Restocks `in 9h 12m`, as the shelf's title says. */
export const restockText = (endsAt: number | null, now: number): string => {
  if (endsAt === null) return ''
  return endsAt <= now ? 'restocking now' : `restocks in ${leftText(endsAt - now)}`
}

const offerEntry = (
  offer: OfferView,
  gold: number,
  now: number,
  width: number,
  care: CareView | null,
): ShopEntry => {
  const ended = offer.endsAt !== null && offer.endsAt <= now
  const action: ShopAction =
    ended
      ? { kind: 'note', row: [dim('restocking…')] }
      : offer.stock === 0
        ? { kind: 'note', row: [dim('sold out today')] }
        : gold < offer.price
          ? { kind: 'note', row: [goldRun(offer.price), dim(` · ${counted(offer.price - gold)} more to go`)] }
          : { kind: 'buy', offerId: offer.offerId, label: `Buy ${goldText(offer.price)}` }
  const isFood = offer.food !== undefined
  const kind = isFood ? offer.rarity : `${offer.rarity} · ${kindOf(offer.category, offer.slot)}`
  const room = roomBeside(offer.name, actionCells([action]), width, entryIndent)
  // Food is eaten, so every copy counts; a look is owned or not.
  const owned = isFood && offer.owned > 0 ? `${offer.owned} owned` : ownedNote(offer.owned)
  const head = headOf(offer.name, offer.rarity, [kind, owned], room)
  const inner = width - detailIndent
  const fed = care?.fed ?? null
  // A treat lifts the mood and nothing else: that is all the shop sells for the pet.
  const details: Array<Row> = isFood
    ? [
        clip(
          [
            ...(fed === null || fed <= 0 ? [dim('a treat')] : [{ text: `+${counted(fed)} mood`, color: 'error' }]),
            dim(' · no XP'),
            ...(offer.stock === null || offer.stock === 0 ? [] : [dim(` · ${offer.stock} left today`)]),
          ],
          inner,
        ),
      ]
    : []
  const slot = slotOf(offer.slot)
  return {
    key: offer.offerId,
    head,
    actions: [action],
    details,
    preview: offer.category === 'bandStyle' && slot !== undefined ? { slot, look: offer.look } : null,
    lore: offer.lore,
  }
}

const spareEntry = (spare: SpareView, gold: number, width: number): ShopEntry => {
  const actions: Array<ShopAction> = []
  if (spare.rerollGold !== null) {
    actions.push(
      gold < spare.rerollGold
        ? { kind: 'note', row: [dim('re-roll '), goldRun(spare.rerollGold)] }
        : { kind: 'reroll', entryId: spare.entryId, label: `Re-roll ${goldText(spare.rerollGold)}` },
    )
  }
  if (spare.salvageShards !== null && spare.salvageShards > 0) {
    actions.push({ kind: 'salvage', entryId: spare.entryId, label: `Salvage +${counted(spare.salvageShards)} ✦` })
  }
  const room = roomBeside(spare.name, actionCells(actions), width, entryIndent)
  const notes = [`${spare.rarity} · ${kindOf(spare.category, spare.slot)}`, `${spare.copies} owned`]
  const head = headOf(spare.name, spare.rarity, notes, room)
  return { key: spare.itemId, head, actions, details: [], preview: null, lore: null }
}

/** A bar for each rarity's shards, toward what a craft takes. */
const shardRows = (shop: ShopView, width: number): Array<Row> => {
  const need = shop.shardsToCraft
  if (need === null || need <= 0) return []
  const labels = Math.max(...shop.shards.map((one) => cellsOf(one.rarity)))
  const count = (one: { count: number }) => `${counted(one.count)}/${counted(need)}`
  const values = Math.max(...shop.shards.map((one) => cellsOf(count(one))))
  const bar = Math.max(4, Math.min(20, width - entryIndent - labels - values - 3))
  return shop.shards.map((one) => {
    const color = rarityColors[one.rarity]
    const value = count(one)
    return clip(
      [
        blank(entryIndent),
        { text: one.rarity, color },
        blank(labels - cellsOf(one.rarity) + 1),
        ...meter(one.count / need, bar, color),
        blank(1 + values - cellsOf(value)),
        one.count >= need ? { text: value, color, bold: true } : dim(value),
      ],
      width,
    )
  })
}

/**
 * The tab for a pane `columns` wide at clock `now`: today's shelf (with live previews of the band styles), the food,
 * the spare copies to trade in, and the shards with what they can make. `petName` names who the food is for.
 */
export const shopLayout = (
  shop: ShopView,
  care: CareView | null,
  petName: string | null,
  columns: number,
  now: number,
): ShopLayout => {
  const width = Math.max(20, Math.min(columns, maxWidth))
  const room = Math.max(20, columns)
  const purse: Run = { text: `${goldText(shop.gold)} gold`, color: 'warning', bold: true }
  const intro = fitting(
    [
      [{ text: 'Shop', bold: true }, dim('  looks and treats for gold, a new shelf each day · '), purse],
      [{ text: 'Shop', bold: true }, dim('  a new shelf each day · '), purse],
      [{ text: 'Shop', bold: true }, dim('  '), purse],
    ],
    room,
  )
  if (!shop.isKnown) {
    const note = fitting(
      [
        [{ text: '◇ ', color: 'warning' }, dim('The server predates the shop: restart it.')],
        [{ text: '◇ ', color: 'warning' }, dim('Restart the server.')],
      ],
      room,
    )
    return { intro, note, width, sections: [] }
  }
  const shelf = shop.offers.filter((offer) => offer.food === undefined)
  const pantry = shop.offers.filter((offer) => offer.food !== undefined)
  const ends = shop.offers.find((offer) => offer.endsAt !== null)?.endsAt ?? null
  const need = shop.shardsToCraft
  const craftEntries = tiers.flatMap((rarity): Array<ShopEntry> => {
    const items = shop.craftable.filter((item) => item.rarity === rarity)
    if (items.length === 0 || need === null) return []
    return items.map((item) => {
      const action: ShopAction = { kind: 'craft', rarity, itemId: item.itemId, label: 'Craft' }
      const notes = [`${rarity} · ${kindOf(item.category, item.slot)}`, ownedNote(item.owned)]
      const head = headOf(item.name, rarity, notes, roomBeside(item.name, actionCells([action]), width, entryIndent))
      return { key: `${rarity}:${item.itemId}`, head, actions: [action], details: [], preview: null, lore: null }
    })
  })
  const sections: Array<ShopSection> = [
    {
      key: 'shelf',
      title: titled("Today's shelf", [restockText(ends, now)], width),
      rows: [],
      entries: shelf.map((offer) => offerEntry(offer, shop.gold, now, width, care)),
      empty: shelf.length === 0 ? clip([dim('Nothing on the shelf today.')], width - entryIndent) : null,
    },
    {
      key: 'food',
      title: titled(
        'Treats',
        petName === null ? ['for your pet, once it hatches', 'for your pet'] : [`for ${petName}`],
        width,
      ),
      rows: [
        fitting(
          [
            [
              blank(entryIndent),
              dim('They lift the mood. Food that boosts XP comes only from play: drops and missions.'),
            ],
            [blank(entryIndent), dim('They lift the mood; XP food comes from play.')],
            [blank(entryIndent), dim('Mood only; XP food comes from play.')],
          ],
          width,
        ),
      ],
      entries: pantry.map((offer) => offerEntry(offer, shop.gold, now, width, care)),
      empty: pantry.length === 0 ? clip([dim('No treats on offer today.')], width - entryIndent) : null,
    },
    {
      key: 'spares',
      title: titled('Duplicates', ['a spare copy, traded in', 'spares'], width),
      rows: [],
      entries: shop.spares.map((spare) => spareEntry(spare, shop.gold, width)),
      empty:
        shop.spares.length === 0
          ? clip([dim('None yet: a second copy of anything can be re-rolled or salvaged here.')], width - entryIndent)
          : null,
    },
    {
      key: 'shards',
      title: titled(
        'Shards',
        need === null
          ? []
          : [`${counted(need)} make an item of their rarity, never a sigil`, `${counted(need)} make one`],
        width,
      ),
      rows: shardRows(shop, width),
      entries: craftEntries,
      empty: null,
    },
  ]
  return { intro, note: null, width, sections }
}

// The pet's card, at the top of the Inventory tab.

/** What the card offers beside a meal. */
export type MealEntry = { key: string; entryId: string; head: Row; lore: string | null }

export type PetCardLayout = {
  title: Row
  /** The pet, its hearts and its mood bar. */
  rows: ReadonlyArray<Row>
  /** Whether the server takes a pat; beside the button, what one does. */
  canPet: boolean
  petHint: Row | null
  /** The food boost running, if any. */
  boost: Row | null
  /** The food's label, and what a meal does. */
  food: Row | null
  meals: ReadonlyArray<MealEntry>
  /** Said in place of the meals when there are none. */
  empty: Row | null
  /** Said when the server is older than pet care. */
  note: Row | null
}

/** The pet as the card shows it: its face and name, and its mood. */
export type PetShown = { face: string; name: string; mood: number }

/** The card for a pane `columns` wide at clock `now`. */
export const petCardLayout = (care: CareView | null, pet: PetShown, columns: number, now: number): PetCardLayout => {
  const width = Math.max(20, Math.min(columns, maxWidth))
  const line = happyLine(care)
  const word = moodWord(pet.mood, line)
  const bonus = care?.happyBonus ?? null
  const feeling = word === 'happy' && bonus !== null && bonus > 0 ? `happy · +${counted(bonus)}% XP` : word
  const title = sectionTitle(pet.name, feeling, width)
  const hearts: Run = { text: heartsFor(pet.mood, line), color: 'error' }
  const mood = Math.round(pet.mood)
  const value = String(mood)
  const bar = Math.max(4, Math.min(24, width - entryIndent - 'Mood '.length - value.length - 1))
  const rows: Array<Row> = [
    clip([blank(entryIndent), { text: pet.face }, { text: `  ${pet.name}  `, bold: true }, hearts], width),
    clip(
      [
        blank(entryIndent),
        dim('Mood '),
        ...meter(pet.mood / 100, bar, word === 'sleepy' ? 'inactive' : 'error'),
        { text: ` ${value}`, bold: word === 'happy' },
      ],
      width,
    ),
  ]
  if (care === null || !care.isKnown) {
    const note = fitting(
      [
        [{ text: '◇ ', color: 'warning' }, dim(`The server predates pet care: restart it to feed ${pet.name}.`)],
        [{ text: '◇ ', color: 'warning' }, dim('Restart the server for pet care.')],
      ],
      width - entryIndent,
    )
    return { title, rows, canPet: false, petHint: null, boost: null, food: null, meals: [], empty: null, note }
  }
  const gain = care.petted
  const most = care.pettedPerHour
  const petHint =
    gain === null || gain <= 0
      ? null
      : fitting(
          [
            [dim(`a pat lifts the mood +${counted(gain)}${most === null ? '' : `, ${counted(most)} pats an hour`}`)],
            [dim(`+${counted(gain)} mood a pat`)],
          ],
          width - entryIndent - buttonCells('Pet'),
        )
  // A meal that has run out since the last snapshot reads as over, by the clock.
  const boost =
    care.boost === null || care.boost.endsAt <= now
      ? null
      : clip(
          [
            blank(entryIndent),
            dim('Fed  '),
            { text: `+${counted(care.boost.pct)}% XP`, color: 'success', bold: true },
            dim(` · ${leftText(care.boost.endsAt - now)} left`),
          ],
          width,
        )
  const fed = care.fed
  const meals = care.meals.map((meal): MealEntry => {
    const notes = [meal.rarity, foodText(meal.food, fed), ...(meal.copies > 1 ? [`${meal.copies} owned`] : [])]
    const head = headOf(meal.name, meal.rarity, notes, roomBeside(meal.name, buttonCells('Feed'), width, detailIndent))
    return { key: meal.itemId, entryId: meal.entryId, head, lore: meal.lore }
  })
  const empty =
    meals.length === 0
      ? clip([dim('No food yet: the Shop tab sells treats, and XP food drops as loot.')], width - detailIndent)
      : null
  const food = fitting(
    [
      [{ text: 'Food', bold: true }, dim('  treats lift the mood; XP food boosts XP too')],
      [{ text: 'Food', bold: true }],
    ],
    width - entryIndent,
  )
  return { title, rows, canPet: true, petHint, boost, food, meals, empty, note: null }
}

/**
 * The card before the egg hatches: the egg by its name and species when the server says them (`egg`, as the welcome
 * picked it or the rules' default), and when it hatches.
 */
export const eggCardLayout = (
  canHatch: boolean,
  columns: number,
  egg: { name: string; species: string } | null = null,
): { title: Row; row: Row } => {
  const width = Math.max(20, Math.min(columns, maxWidth))
  const unnamed = canHatch ? 'Your egg is ready to hatch.' : 'Your egg hatches at Lv 1.'
  const when = canHatch ? 'ready to hatch' : 'hatches at Lv 1'
  const said: Row =
    egg === null ? [dim(unnamed)] : [{ text: egg.name, bold: true }, dim(` the ${egg.species} · ${when}`)]
  const row: Row = [blank(entryIndent), { text: '🥚 ' }, ...said]
  return { title: sectionTitle('Pet', canHatch ? 'ready' : '', width), row: clip(row, width) }
}
