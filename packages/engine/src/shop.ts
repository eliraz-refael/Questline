import type { Context, ItemDef, PlayerState, ShopOffer } from "@questline/schema"
import { addDays, localDay, startOfDay } from "./days.ts"
import { rarityRank } from "./loot.ts"
import { draws } from "./random.ts"
import { isSigil } from "./sigils.ts"

// The shop: a shelf of items drawn anew each local day, and the food on offer every day, each so many a day, for gold.
// The offers are worked out from the day, the rules and the catalogue, so only what was bought today is stored. The
// same day draws the same shelf for every player. The shop never sells a sigil: gold buys looks and food, never a
// multiplier on XP.

type ShopContext = Pick<Context, "rules" | "catalog">

/** An offer's id: the day it is on offer and the item, so an offer from a day gone by reads as ended. */
export const offerIdOf = (day: string, itemId: string): string => `${day}/${itemId}`

/** The day and item an offer id names, if it is one. */
export const offerParts = (offerId: string): { readonly day: string; readonly itemId: string } | undefined => {
  const match = /^(\d{4}-\d{2}-\d{2})\/(.+)$/u.exec(offerId)
  const day = match?.[1]
  const itemId = match?.[2]
  return day === undefined || itemId === undefined ? undefined : { day, itemId }
}

const isFood = (item: ItemDef): boolean => item.category === "food"

const byRarityThenName = (a: ItemDef, b: ItemDef): number =>
  rarityRank(a.rarity) - rarityRank(b.rarity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/** The shelf of `day`: `offers` items drawn without repeats from the rarities and categories the rules sell. */
export const shelfOf = (day: string, context: ShopContext): ReadonlyArray<ItemDef> => {
  const { shop } = context.rules
  const pool = context.catalog
    .filter(
      (item) =>
        !isSigil(item) &&
        !isFood(item) &&
        shop.rarities.includes(item.rarity) &&
        shop.categories.includes(item.category),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
  const next = draws("questline-shop", day)
  const left = [...pool]
  const picked: Array<ItemDef> = []
  while (picked.length < shop.offers && left.length > 0) {
    const [item] = left.splice(Math.floor(next() * left.length), 1)
    if (item !== undefined) picked.push(item)
  }
  return picked.sort(byRarityThenName)
}

/** The food on offer every day: each food of the shop's rarities. */
export const pantryOf = (context: ShopContext): ReadonlyArray<ItemDef> =>
  context.catalog
    .filter((item) => isFood(item) && !isSigil(item) && context.rules.shop.rarities.includes(item.rarity))
    .sort(byRarityThenName)

/** An item of the shop today: its price and how many a day it sells. */
export interface Ware {
  readonly item: ItemDef
  readonly price: number
  readonly stock: number
}

/** What the shop sells on `day`: the shelf, then the food. */
export const waresOf = (day: string, context: ShopContext): ReadonlyArray<Ware> => {
  const { shop } = context.rules
  return [
    ...shelfOf(day, context).map((item) => ({ item, price: shop.prices[item.rarity], stock: shop.stock })),
    ...pantryOf(context).map((item) => ({ item, price: shop.food.prices[item.rarity], stock: shop.food.stock })),
  ]
}

/** How many of an offer were bought today, as the holdings count them. */
export const boughtToday = (state: PlayerState, day: string, offerId: string): number =>
  state.holdings.shop.day === day ? (state.holdings.shop.bought[offerId] ?? 0) : 0

/** Today's offers as the snapshot shows them, with the copies left and when the shop restocks. */
export const shopOffers = (state: PlayerState, context: ShopContext, now: string): ReadonlyArray<ShopOffer> => {
  const day = localDay(now, state.timezone)
  const endsAt = startOfDay(addDays(day, 1), state.timezone)
  return waresOf(day, context).map(({ item, price, stock }) => {
    const offerId = offerIdOf(day, item.id)
    return { offerId, itemId: item.id, price, stock: Math.max(0, stock - boughtToday(state, day, offerId)), endsAt }
  })
}

/** The items the player's shards can make now: every item but a sigil, of each rarity with enough shards. */
export const craftable = (state: PlayerState, context: Pick<Context, "rules" | "catalog">): ReadonlyArray<ItemDef> =>
  context.catalog.filter(
    (item) => !isSigil(item) && state.holdings.shards[item.rarity] >= context.rules.loot.shardsToCraft,
  )
