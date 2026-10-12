import { it } from "@effect/vitest"
import type { CommandResponse, ItemReroll, ItemSalvage, ShardsCraft, ShopBuy } from "@pathofdev/schema"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { client, hatch, nextId, session, withoutQuests, withServer } from "./fixtures.ts"

// The shop and pet care over the routes, in the dev sandbox, whose commands set the gold, the XP and the shards.

const typesOf = (response: CommandResponse) =>
  response.status === "ok" ? withoutQuests(response.events).map((event) => event.type) : response.code

describe("the shop and pet care, end to end", () => {
  it.effect("sells today's offers for gold, keeps what was bought, and feeds and pats the pet", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        // The level-up drops something with its gold, so the gold is set after it.
        yield* api.runCommand({ payload: { id: nextId(), type: "dev.grantXp", data: { amount: 150 } } })
        expect(typesOf(yield* api.runCommand({ payload: hatch() }))).toEqual(["pet.hatched"])
        yield* api.runCommand({ payload: { id: nextId(), type: "dev.setGold", data: { gold: 1000 } } })
        const opened = yield* api.openSession({ payload: { sessionId: session } })
        const { shop, items } = opened.snapshot
        expect(shop.map((offer) => offer.stock)).toEqual([1, 1, 1, 1, 3, 3])
        for (const offer of shop) expect(items.some((item) => item.id === offer.itemId)).toBe(true)
        const food = shop.find((offer) => offer.itemId === "honey-biscuit")
        if (food === undefined) throw new Error("no food on offer")

        const buy: typeof ShopBuy.Type = { id: nextId(), type: "shop.buy", data: { offerId: food.offerId } }
        expect(typesOf(yield* api.runCommand({ payload: buy }))).toEqual(["shop.bought", "gold.changed"])
        const bought = yield* api.openSession({ payload: { sessionId: session } })
        expect(bought.snapshot.character.gold).toBe(1000 - food.price)
        expect(bought.snapshot.shop.find((offer) => offer.offerId === food.offerId)?.stock).toBe(2)
        // The level-up's drop may be food too: the meal is the one the shop sold.
        const meal = bought.snapshot.inventory.find((entry) => entry.source.kind === "shop")
        if (meal === undefined) throw new Error("the food never arrived")
        expect(meal).toMatchObject({ itemId: "honey-biscuit", source: { kind: "shop", ref: food.offerId } })

        yield* api.runCommand({ payload: { id: nextId(), type: "dev.setMood", data: { mood: 40 } } })
        const fed = yield* api.runCommand({ payload: { id: nextId(), type: "pet.feed", data: { entryId: meal.id } } })
        expect(typesOf(fed)).toEqual(["pet.fed"])
        const patted = yield* api.runCommand({ payload: { id: nextId(), type: "pet.pet", data: {} } })
        expect(typesOf(patted)).toEqual(["pet.petted"])
        const after = yield* api.openSession({ payload: { sessionId: session } })
        // A treat lifts the mood and nothing else: no XP boost from gold.
        expect(after.snapshot.pet?.mood).toBe(75)
        expect(after.snapshot.boosts).toEqual([])
        expect(after.snapshot.inventory.some((entry) => entry.id === meal.id)).toBe(false)
      }),
      undefined,
      true,
    ),
  )

  it.effect("re-rolls and salvages a duplicate, and crafts with shards, refusing a sigil", () =>
    withServer(
      Effect.gen(function* () {
        const api = yield* client
        yield* api.runCommand({ payload: { id: nextId(), type: "dev.setGold", data: { gold: 1000 } } })
        for (let i = 0; i < 3; i++) {
          yield* api.runCommand({ payload: { id: nextId(), type: "dev.grantItem", data: { itemId: "solid-bar" } } })
        }
        const owned = (yield* api.openSession({ payload: { sessionId: session } })).snapshot.inventory
        const [, second, third] = owned
        if (second === undefined || third === undefined) throw new Error("the copies never arrived")
        const reroll: typeof ItemReroll.Type = { id: nextId(), type: "item.reroll", data: { entryId: second.id } }
        expect(typesOf(yield* api.runCommand({ payload: reroll }))).toEqual(["item.rerolled", "gold.changed"])
        const salvage: typeof ItemSalvage.Type = { id: nextId(), type: "item.salvage", data: { entryId: third.id } }
        expect(typesOf(yield* api.runCommand({ payload: salvage }))).toEqual(["item.salvaged"])
        const traded = (yield* api.openSession({ payload: { sessionId: session } })).snapshot
        expect(traded.character.shards.common).toBe(1)
        expect(traded.character.gold).toBe(980)

        yield* api.runCommand({ payload: { id: nextId(), type: "dev.setShards", data: { count: 10 } } })
        const craft = (itemId: string): typeof ShardsCraft.Type => ({
          id: nextId(),
          type: "shards.craft",
          data: { rarity: "epic", itemId },
        })
        expect(yield* api.runCommand({ payload: craft("arcane-sigil") })).toEqual({
          status: "refused",
          code: "not_allowed",
          message: "Arcane Sigil is a sigil, which comes only from play, never from gold or shards",
        })
        expect(typesOf(yield* api.runCommand({ payload: craft("pixel-dragon") }))).toEqual(["shards.crafted"])
      }),
      undefined,
      true,
    ),
  )
})
