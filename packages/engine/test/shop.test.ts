import type {
  ClientEvent,
  Command,
  Context,
  GradeDimension,
  Input,
  InventoryEntry,
  OwnedPet,
  PlayerState,
  Recorded,
  ServerEventDraft,
  Step,
} from "@questline/schema"
import { Snapshot as SnapshotSchema, Step as StepSchema } from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  initialState,
  moodNow,
  offerIdOf,
  pantryOf,
  project,
  shelfOf,
  shopOffers,
  starterCatalog,
  starterRules,
  step,
} from "../src/index.ts"

// The shop, caring for the pet and trading duplicates in: what gold buys (looks and food, never a sigil), what food and
// a pat do for the pet's mood and so for the happy bonus, and what a re-roll, a salvage and a shard craft make.

const start = "2026-10-09T08:00:00.000Z"
const today = "2026-10-09"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"

const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

const command = (cmd: Command): Input => ({ kind: "command", command: cmd })
const buy = (offerId: string): Input => command({ id: nextId(), type: "shop.buy", data: { offerId } })
const feed = (entryId: string): Input => command({ id: nextId(), type: "pet.feed", data: { entryId } })
const pat = (): Input => command({ id: nextId(), type: "pet.pet", data: {} })
const reroll = (entryId: string): Input => command({ id: nextId(), type: "item.reroll", data: { entryId } })
const salvage = (entryId: string): Input => command({ id: nextId(), type: "item.salvage", data: { entryId } })
const craft = (rarity: "common" | "uncommon" | "rare", itemId: string): Input =>
  command({ id: nextId(), type: "shards.craft", data: { rarity, itemId } })

const flat = (score: number): Record<GradeDimension, number> => ({
  clarity: score,
  grammar: score,
  specificity: score,
  instructive: score,
  context: score,
  doneCriteria: score,
  focus: score,
  regret: 0,
})

/** A prompt graded `score` on every quality, at `minutes` after the start: worth `2 * score` XP before boosts. */
const prompt = (score: number, minutes: number): Input => {
  const data: Extract<ClientEvent, { type: "prompt.graded" }>["data"] = {
    scores: flat(score),
    rubricVersion: 1,
    words: 12,
    grader: "haiku",
  }
  return {
    kind: "client",
    event: { id: nextId(), occurredAt: minutesLater(minutes), sessionId: session, type: "prompt.graded", data },
  }
}

const contextAt = (logSeq: number, now: string, mode: Context["mode"] = { kind: "live" }, dev = false): Context => ({
  now,
  logSeq,
  rollSeed: "secret-seed",
  rules: starterRules,
  catalog: starterCatalog,
  questPacks: [],
  mode,
  ...(dev ? { dev: true } : {}),
})

/** Inputs at `start`, a minute apart unless a client event names its own time. */
const play = (inputs: ReadonlyArray<Input>, state: PlayerState, at: (i: number) => string = minutesLater) => {
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    const now = input.kind === "client" ? input.event.occurredAt : at(i)
    const result = step(state, input, contextAt(i + 1, now))
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((one) => one.events) }
}

/** The same inputs again in a replay, each taking what its live step recorded. */
const replay = (inputs: ReadonlyArray<Input>, recorded: ReadonlyArray<Recorded>, state: PlayerState) => {
  for (const [i, input] of inputs.entries()) {
    const now = input.kind === "client" ? input.event.occurredAt : minutesLater(i)
    const mode: Context["mode"] = { kind: "replay", recorded: recorded[i] ?? { rolls: [], refusal: null } }
    state = step(state, input, contextAt(i + 1, now, mode)).state
  }
  return state
}

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

const pet = (mood: number, at = start): OwnedPet => ({
  species: "fox",
  name: "Ember",
  hatchedAt: start,
  forms: [0],
  form: 0,
  mood: { value: mood, at },
  petted: [],
})

const entryIds = Array.from({ length: 8 }, (_, i) => `01K6ZQ8W3J00000000000090${String(i).padStart(2, "0")}`)

/** A player with `gold`, a pet at `mood` (or none), owning these items, entry ids from `entryIds` in order. */
const player = (
  options: { gold?: number; mood?: number | null; items?: ReadonlyArray<string>; shards?: number } = {},
): PlayerState => {
  const state = fresh()
  const source: InventoryEntry["source"] = { kind: "drop", ref: "0" }
  const inventory = (options.items ?? []).map(
    (itemId, i): InventoryEntry => ({ id: entryIds[i] ?? nextId(), itemId, acquiredAt: start, source, dye: null }),
  )
  const shards = options.shards ?? 0
  return {
    ...state,
    holdings: {
      ...state.holdings,
      gold: options.gold ?? 0,
      pet: options.mood === undefined || options.mood === null ? null : pet(options.mood),
      inventory,
      shards: { common: shards, uncommon: shards, rare: shards, epic: shards, legendary: shards },
    },
  }
}

const snapshotOf = (state: PlayerState, now = start) =>
  project(
    state,
    { rules: starterRules, catalog: starterCatalog, questPacks: [], now },
    {
      player: {
        id: session,
        githubUserId: null,
        githubLogin: null,
        displayName: "Player",
        createdAt: start,
      },
      serverId: "local-test",
      streamEpoch: 1,
      cursor: 0,
    },
  )

const typesOf = (events: ReadonlyArray<ServerEventDraft>) => events.map((event) => event.type)

const shelf = shelfOf(today, { rules: starterRules, catalog: starterCatalog })
const firstOffer = shelf[0]

describe("the shop: today's offers", () => {
  it("puts four band styles on the shelf, commons and uncommons, and the food every day, until local midnight", () => {
    expect(shelf).toHaveLength(4)
    for (const item of shelf) {
      expect(item.category).toBe("bandStyle")
      expect(["common", "uncommon"]).toContain(item.rarity)
    }
    expect(pantryOf({ rules: starterRules, catalog: starterCatalog }).map((item) => item.id)).toEqual([
      "trail-mix",
      "berry-tart",
    ])
    const offers = shopOffers(player(), { rules: starterRules, catalog: starterCatalog }, start)
    expect(offers.map((offer) => offer.itemId)).toEqual([...shelf.map((item) => item.id), "trail-mix", "berry-tart"])
    expect(offers.map((offer) => offer.stock)).toEqual([1, 1, 1, 1, 3, 3])
    expect(offers.find((offer) => offer.itemId === "trail-mix")).toEqual({
      offerId: "2026-10-09/trail-mix",
      itemId: "trail-mix",
      price: 25,
      stock: 3,
      endsAt: "2026-10-10T00:00:00.000Z",
    })
    for (const offer of offers.slice(0, 4)) {
      const item = shelf.find((one) => one.id === offer.itemId)
      expect(offer.price).toBe(item?.rarity === "common" ? 120 : 250)
    }
  })

  it("draws the same shelf all day for everyone, and a new one each day", () => {
    const again = shelfOf(today, { rules: starterRules, catalog: starterCatalog })
    expect(again.map((item) => item.id)).toEqual(shelf.map((item) => item.id))
    const week = Array.from({ length: 7 }, (_, i) =>
      shelfOf(`2026-10-${String(9 + i).padStart(2, "0")}`, { rules: starterRules, catalog: starterCatalog })
        .map((item) => item.id)
        .join(","),
    )
    expect(new Set(week).size).toBeGreaterThan(1)
  })

  it("ends at the player's local midnight, in their time zone", () => {
    const state = { ...player(), timezone: "America/New_York" }
    const offers = shopOffers(state, { rules: starterRules, catalog: starterCatalog }, start)
    expect(offers[0]?.offerId.startsWith("2026-10-09/")).toBe(true)
    expect(offers[0]?.endsAt).toBe("2026-10-10T04:00:00.000Z")
  })

  it("carries the offers' definitions on the snapshot, which decodes", () => {
    const snapshot = snapshotOf(player())
    expect(Schema.decodeUnknownSync(SnapshotSchema)(snapshot)).toEqual(snapshot)
    const shown = new Set(snapshot.items.map((item) => item.id))
    for (const offer of snapshot.shop) expect(shown.has(offer.itemId)).toBe(true)
  })
})

describe("the shop: buying", () => {
  it("takes the price in gold and puts the item in the inventory, from the shop, one copy a day", () => {
    if (firstOffer === undefined) throw new Error("no shelf")
    const offerId = offerIdOf(today, firstOffer.id)
    const price = starterRules.shop.prices[firstOffer.rarity]
    const { state, steps, events } = play([buy(offerId), buy(offerId)], player({ gold: 1000 }))
    expect(steps.map((one) => one.refusal)).toEqual([
      null,
      { code: "sold_out", message: `${firstOffer.name} is sold out for today` },
    ])
    expect(typesOf(events)).toEqual(["shop.bought", "gold.changed"])
    const spent = { delta: -price, totalAfter: 1000 - price, reason: "shop" }
    expect(events[1]).toEqual({ type: "gold.changed", data: spent })
    expect(state.holdings.gold).toBe(1000 - price)
    expect(state.holdings.inventory).toMatchObject([{ itemId: firstOffer.id, source: { kind: "shop", ref: offerId } }])
    expect(state.holdings.shop).toEqual({ day: today, bought: { [offerId]: 1 } })
    expect(snapshotOf(state).shop.find((offer) => offer.offerId === offerId)?.stock).toBe(0)
    for (const one of steps) expect(Schema.decodeUnknownSync(StepSchema)(one)).toEqual(one)
  })

  it("sells three of each food a day, and restocks at the next local midnight", () => {
    const offerId = offerIdOf(today, "trail-mix")
    const { state, steps } = play([buy(offerId), buy(offerId), buy(offerId), buy(offerId)], player({ gold: 1000 }))
    expect(steps.map((one) => one.refusal?.code ?? null)).toEqual([null, null, null, "sold_out"])
    expect(state.holdings.gold).toBe(1000 - 3 * 25)
    const tomorrow = "2026-10-10T09:00:00.000Z"
    expect(snapshotOf(state, tomorrow).shop.find((offer) => offer.itemId === "trail-mix")?.stock).toBe(3)
    const next = step(state, buy(offerIdOf("2026-10-10", "trail-mix")), contextAt(9, tomorrow))
    expect(next.refusal).toBe(null)
    expect(next.state.holdings.shop).toEqual({ day: "2026-10-10", bought: { "2026-10-10/trail-mix": 1 } })
  })

  it("refuses an offer it can't afford, one that has ended, and one that never was", () => {
    if (firstOffer === undefined) throw new Error("no shelf")
    const price = starterRules.shop.prices[firstOffer.rarity]
    const poor = player({ gold: price - 1 })
    const { steps, state } = play(
      [buy(offerIdOf(today, firstOffer.id)), buy(offerIdOf("2026-10-08", "trail-mix")), buy("wizard-hat")],
      poor,
    )
    expect(steps.map((one) => one.refusal)).toEqual([
      {
        code: "insufficient_gold",
        message: `${firstOffer.name} costs ${price} gold, and you have ${price - 1}`,
      },
      { code: "sold_out", message: "That offer has ended: the shop restocks each day" },
      { code: "invalid", message: "No offer has that id" },
    ])
    expect(state).toEqual(poor)
    const notToday = step(poor, buy(offerIdOf(today, "wizard-hat")), contextAt(1, start))
    expect(notToday.refusal).toEqual({ code: "invalid", message: "The shop has no such offer today" })
  })

  it("replays a purchase as it was made: the same entry, the same gold", () => {
    const inputs = [buy(offerIdOf(today, "trail-mix")), buy(offerIdOf(today, "berry-tart"))]
    const live = play(inputs, player({ gold: 500 }))
    const replayed = replay(
      inputs,
      live.steps.map((one) => ({ rolls: one.rolls, refusal: one.refusal })),
      player({ gold: 500 }),
    )
    expect(replayed).toEqual(live.state)
  })
})

describe("caring for the pet", () => {
  it("food lifts its mood, starts the food's boost and is eaten", () => {
    const state = player({ mood: 40, items: ["trail-mix"] })
    const { state: after, events } = play([feed(entryIds[0] ?? "")], state)
    expect(after.holdings.inventory).toEqual([])
    expect(after.holdings.pet?.mood).toEqual({ value: 70, at: start })
    expect(after.progress.boosts).toEqual([
      { kind: "food", source: "trail-mix", xpBoostPct: 10, endsAt: minutesLater(60) },
    ])
    expect(events).toEqual([
      {
        type: "pet.fed",
        data: {
          entryId: entryIds[0],
          itemId: "trail-mix",
          name: "Trail Mix",
          mood: 70,
          xpBoost: { pct: 10, minutes: 60 },
        },
      },
    ])
  })

  it("makes the happy bonus reachable: a meal takes a sleepy pet past happy, and its XP shows it", () => {
    // Mood 50 is below happy (above 70): a 10 XP prompt earns 10.
    const sleepy = player({ mood: 50, items: ["trail-mix"] })
    const before = play([prompt(5, 0)], sleepy)
    expect(before.events.find((event) => event.type === "xp.granted" && event.data.reason === "prompt.graded"))
      .toMatchObject({ data: { amount: 10 } })
    // Fed, the pet is at 80, past 70: happy (+5%), plus the meal's own +10%. The next prompt earns 11.
    const fed = play([feed(entryIds[0] ?? ""), prompt(5, 5)], sleepy)
    const grant = fed.events.find((event) => event.type === "xp.granted" && event.data.reason === "prompt.graded")
    expect(grant).toMatchObject({ data: { amount: 11 } })
    const fedPet = fed.state.holdings.pet
    expect(fedPet === null ? 0 : moodNow(fedPet, starterRules, minutesLater(5))).toBeGreaterThan(70)
  })

  it("two meals never stack their boosts: the strongest running one counts", () => {
    const state = player({ mood: 100, items: ["trail-mix", "berry-tart"] })
    const fed = play([feed(entryIds[0] ?? ""), feed(entryIds[1] ?? ""), prompt(10, 5)], state)
    // 20 XP: happy 5% and one food's 10%, not two.
    const grant = fed.events.find((event) => event.type === "xp.granted" && event.data.reason === "prompt.graded")
    expect(grant).toMatchObject({ data: { amount: 23 } })
    expect(fed.state.progress.boosts.map((boost) => boost.endsAt)).toEqual([minutesLater(60), minutesLater(121)])
  })

  it("a pat lifts the mood a little, three an hour; past them it is never refused and adds nothing", () => {
    const state = player({ mood: 50 })
    const pats = play([pat(), pat(), pat(), pat()], state)
    expect(pats.steps.map((one) => one.refusal)).toEqual([null, null, null, null])
    const gains = pats.events.flatMap((event) => (event.type === "pet.petted" ? [Math.round(event.data.gained)] : []))
    expect(gains).toEqual([5, 5, 5, 0])
    // Three pats were counted; an hour after them, a pat counts again.
    expect(pats.state.holdings.pet?.petted).toEqual([minutesLater(0), minutesLater(1), minutesLater(2)])
    const capped = step(pats.state, pat(), contextAt(5, minutesLater(59)))
    expect(capped.events).toMatchObject([{ type: "pet.petted", data: { gained: 0 } }])
    const later = step(pats.state, pat(), contextAt(5, minutesLater(64)))
    expect(later.events).toMatchObject([{ type: "pet.petted", data: { gained: expect.closeTo(5, 1) } }])
    expect(later.state.holdings.pet?.petted).toEqual([minutesLater(64)])
  })

  it("refuses food that is not food, food it doesn't own, and care before the egg hatches", () => {
    const state = player({ mood: 50, items: ["wizard-hat"] })
    const { steps } = play([feed(entryIds[0] ?? ""), feed(nextId())], state)
    expect(steps.map((one) => one.refusal)).toEqual([
      { code: "invalid", message: "Ember eats only food" },
      { code: "not_owned", message: "That food is not in the inventory" },
    ])
    const egg = player({ items: ["trail-mix"] })
    const unhatched = play([feed(entryIds[0] ?? ""), pat()], egg)
    expect(unhatched.steps.map((one) => one.refusal?.code)).toEqual(["not_allowed", "not_allowed"])
    expect(unhatched.state).toEqual(egg)
  })

  it("a hatched pet starts with no pats counted", () => {
    const hatch = command({ id: nextId(), type: "pet.hatch", data: { species: "fox", name: "Ember" } })
    const leveled = { ...player(), progress: { ...player().progress, xp: { verified: 0, reported: 150 } } }
    expect(step(leveled, hatch, contextAt(1, start)).state.holdings.pet?.petted).toEqual([])
  })
})

describe("duplicates", () => {
  it("a re-roll trades a spare copy and gold for another item of its rarity, with no gold and no pity", () => {
    const state = player({ gold: 100, items: ["solid-bar", "solid-bar"] })
    const { state: after, steps, events } = play([reroll(entryIds[1] ?? "")], state)
    expect(steps[0]?.refusal).toBe(null)
    expect(typesOf(events)).toEqual(["item.rerolled", "gold.changed"])
    expect(events[1]).toEqual({ type: "gold.changed", data: { delta: -20, totalAfter: 80, reason: "reroll" } })
    const made = after.holdings.inventory.at(-1)
    const item = starterCatalog.find((one) => one.id === made?.itemId)
    expect(item?.rarity).toBe("common")
    expect(item?.id).not.toBe("solid-bar")
    expect(item?.sigil).toBe(undefined)
    expect(made?.source).toEqual({ kind: "craft", ref: `reroll/${entryIds[1]}` })
    expect(after.holdings.inventory.map((entry) => entry.id)).not.toContain(entryIds[1])
    expect(after.holdings.loot.pity).toEqual(state.holdings.loot.pity)
    expect(after.holdings.loot.nextRoll).toBe(1)
    expect(steps[0]?.rolls).toMatchObject([{ trigger: "reroll", chance: 1, drop: { rarity: "common", gold: 0 } }])
    expect(events[0]).toMatchObject({
      type: "item.rerolled",
      data: { from: { entryId: entryIds[1], itemId: "solid-bar", name: "Solid Bar" }, price: 20, tier: "common" },
    })
    // A replay makes the same item from the recorded roll.
    const recorded = steps.map((one) => ({ rolls: one.rolls, refusal: one.refusal }))
    expect(replay([reroll(entryIds[1] ?? "")], recorded, state)).toEqual(after)
  })

  it("refuses the only copy, the copy worn, and a re-roll it can't afford", () => {
    const one = player({ gold: 100, items: ["solid-bar"] })
    expect(step(one, reroll(entryIds[0] ?? ""), contextAt(1, start)).refusal).toEqual({
      code: "not_allowed",
      message: "Only a duplicate can be traded in, and you have one Solid Bar",
    })
    const two = player({ gold: 100, items: ["solid-bar", "solid-bar"] })
    const worn = { ...two, holdings: { ...two.holdings, equipped: { xpBar: entryIds[0] ?? "" } } }
    expect(step(worn, reroll(entryIds[0] ?? ""), contextAt(1, start)).refusal).toEqual({
      code: "not_allowed",
      message: "That copy is worn: trade in a spare one",
    })
    const poor = player({ gold: 19, items: ["solid-bar", "solid-bar"] })
    expect(step(poor, reroll(entryIds[1] ?? ""), contextAt(1, start)).refusal).toEqual({
      code: "insufficient_gold",
      message: "A common re-roll costs 20 gold, and you have 19",
    })
    expect(step(poor, reroll(nextId()), contextAt(1, start)).refusal?.code).toBe("not_owned")
  })

  it("a salvage breaks a spare copy into a shard of its rarity", () => {
    const state = player({ items: ["knit-scarf", "knit-scarf"] })
    const { state: after, events } = play([salvage(entryIds[1] ?? ""), salvage(entryIds[0] ?? "")], state)
    expect(after.holdings.shards.uncommon).toBe(1)
    expect(after.holdings.inventory.map((entry) => entry.id)).toEqual([entryIds[0]])
    expect(events).toEqual([
      {
        type: "item.salvaged",
        data: {
          entryId: entryIds[1],
          itemId: "knit-scarf",
          name: "Knit Scarf",
          rarity: "uncommon",
          shards: 1,
          totalAfter: 1,
        },
      },
    ])
  })

  it("ten shards of a rarity craft a chosen item of it, and the snapshot names what they can make", () => {
    const state = player({ shards: 10 })
    const crafted = play([craft("rare", "wizard-hat"), craft("rare", "fireworks")], state)
    expect(crafted.steps.map((one) => one.refusal)).toEqual([
      null,
      { code: "insufficient_shards", message: "Crafting takes 10 rare shards, and you have 0" },
    ])
    expect(crafted.state.holdings.shards.rare).toBe(0)
    expect(crafted.state.holdings.inventory).toMatchObject([{ itemId: "wizard-hat", source: { kind: "craft" } }])
    expect(crafted.events).toMatchObject([
      { type: "shards.crafted", data: { rarity: "rare", spent: 10, totalAfter: 0, item: { id: "wizard-hat" } } },
    ])
    const wrong = step(state, craft("common", "wizard-hat"), contextAt(1, start))
    expect(wrong.refusal).toEqual({ code: "invalid", message: "Wizard Hat is rare, not common" })
    // What the shards can make rides on the snapshot, sigils never among it.
    const shown = new Set(snapshotOf(state).items.map((item) => item.id))
    expect(shown.has("wizard-hat")).toBe(true)
    expect(shown.has("arcane-sigil")).toBe(false)
    expect(new Set(snapshotOf(player()).items.map((item) => item.id)).has("wizard-hat")).toBe(false)
  })
})

describe("dev mode: the shop and the pet", () => {
  const dev = (cmd: Command, state: PlayerState, isDev = true) =>
    step(state, command(cmd), contextAt(1, start, { kind: "live" }, isDev))

  it("restocks the shop, sets the pet's mood and the shards, and refuses all three off dev mode", () => {
    const offerId = offerIdOf(today, "trail-mix")
    const bought = play([buy(offerId)], player({ gold: 100, mood: 50 })).state
    const restocked = dev({ id: nextId(), type: "dev.restockShop", data: {} }, bought)
    expect(restocked.state.holdings.shop).toEqual({ day: today, bought: {} })
    const mood = dev({ id: nextId(), type: "dev.setMood", data: { mood: 15 } }, bought)
    expect(mood.state.holdings.pet?.mood).toEqual({ value: 15, at: start })
    expect(mood.events).toEqual([{ type: "pet.changed", data: { mood: 15 } }])
    const shards = dev({ id: nextId(), type: "dev.setShards", data: { count: 10 } }, bought)
    expect(Object.values(shards.state.holdings.shards)).toEqual([10, 10, 10, 10, 10])
    for (const cmd of [
      { id: nextId(), type: "dev.restockShop", data: {} },
      { id: nextId(), type: "dev.setMood", data: { mood: 15 } },
      { id: nextId(), type: "dev.setShards", data: { count: 10 } },
    ] satisfies Array<Command>) {
      expect(dev(cmd, bought, false).refusal?.code).toBe("not_allowed")
    }
    expect(dev({ id: nextId(), type: "dev.setMood", data: { mood: 15 } }, player()).refusal?.code).toBe("not_allowed")
  })
})
