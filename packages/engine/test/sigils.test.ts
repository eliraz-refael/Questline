import type {
  Boost,
  ClientEvent,
  Command,
  Context,
  GradeDimension,
  Input,
  InventoryEntry,
  ItemDef,
  OwnedPet,
  PlayerState,
  QuestPack,
  Rarity,
  Recorded,
  RulesConfig,
  ServerEventDraft,
  Step,
} from "@questline/schema"
import {
  catalogIssue,
  ItemDef as ItemDefSchema,
  RulesConfig as RulesSchema,
  Step as StepSchema,
} from "@questline/schema"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  equippedSigil,
  initialState,
  isSigil,
  levelOf,
  project,
  rollLoot,
  starterCatalog,
  starterQuestPack,
  starterRules,
  step,
  xpForLevel,
} from "../src/index.ts"

// Sigils: one equipped, a multiplier on graded prompts' XP, priced base, band, sigil, then the flat boosts, rounded
// down once; drops only. With them, the mission XP boost and the XP a curve change carries.

const start = "2026-10-09T08:00:00.000Z"
const session = "01K6ZQ8W3J5V7XKQ2M4N6P8R9T"
const repo: { type: "github"; repo: string; key: string } = {
  type: "github",
  repo: "acme/widgets",
  key: "ab".repeat(32),
}

const minutesLater = (minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString()

let ids = 0
const nextId = (): string => `01K6ZQ8W3J${String(ids++).padStart(16, "0")}`

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

type Graded = Extract<ClientEvent, { type: "prompt.graded" }>

/** A prompt graded `score` on every quality: maxXp 20 makes it worth `2 * score` XP in the day's first band. */
const prompt = (score: number, minutes = 0, scores = flat(score)): Input => {
  const base = { id: nextId(), occurredAt: minutesLater(minutes), sessionId: session }
  const data: Graded["data"] = { scores, rubricVersion: 1, words: 12, grader: "haiku" }
  const event: ClientEvent = { ...base, type: "prompt.graded", data }
  return { kind: "client", event }
}

const commit = (minutes = 0): Input => {
  const data = { commit: { ...repo, sha: "a".repeat(40) } }
  const base = { id: nextId(), occurredAt: minutesLater(minutes), sessionId: session }
  const event: ClientEvent = { ...base, type: "commit.made", data }
  return { kind: "client", event }
}

const command = (cmd: Command): Input => ({ kind: "command", command: cmd })
const equip = (entryId: string): Input =>
  command({ id: nextId(), type: "item.equip", data: { entryId, slot: "sigil" } })
const unequip = (): Input => command({ id: nextId(), type: "item.unequip", data: { slot: "sigil" } })

const contextAt = (
  logSeq: number,
  now: string,
  options: { rules?: RulesConfig; catalog?: ReadonlyArray<ItemDef>; packs?: ReadonlyArray<QuestPack> } = {},
  mode: Context["mode"] = { kind: "live" },
): Context => ({
  now,
  logSeq,
  rollSeed: "secret-seed",
  rules: options.rules ?? starterRules,
  catalog: options.catalog ?? starterCatalog,
  questPacks: options.packs ?? [],
  mode,
})

const nowOf = (input: Input): string => (input.kind === "client" ? input.event.occurredAt : start)

type Options = { rules?: RulesConfig; catalog?: ReadonlyArray<ItemDef>; packs?: ReadonlyArray<QuestPack> }

const play = (inputs: ReadonlyArray<Input>, state: PlayerState, options: Options = {}) => {
  const steps: Array<Step> = []
  for (const [i, input] of inputs.entries()) {
    const result = step(state, input, contextAt(i + 1, nowOf(input), options))
    steps.push(result)
    state = result.state
  }
  return { state, steps, events: steps.flatMap((s) => s.events) }
}

const replay = (
  inputs: ReadonlyArray<Input>,
  recorded: ReadonlyArray<Recorded>,
  state: PlayerState,
  options: Options = {},
) => {
  const events: Array<ServerEventDraft> = []
  for (const [i, input] of inputs.entries()) {
    const mode: Context["mode"] = { kind: "replay", recorded: recorded[i] ?? { rolls: [], refusal: null } }
    const result = step(state, input, contextAt(i + 1, nowOf(input), options, mode))
    events.push(...result.events)
    state = result.state
  }
  return { state, events }
}

const fresh = (): PlayerState => initialState({ characterName: "Player", timezone: "UTC", now: start })

const entryIds = ["01K6ZQ8W3J0000000000009001", "01K6ZQ8W3J0000000000009002", "01K6ZQ8W3J0000000000009003"]

/** A player owning these items, entry ids from `entryIds` in order, at peak level 0. */
const owning = (...itemIds: ReadonlyArray<string>): PlayerState => {
  const state = fresh()
  const source: InventoryEntry["source"] = { kind: "drop", ref: "0" }
  const inventory = itemIds.map(
    (itemId, i): InventoryEntry => ({ id: entryIds[i] ?? nextId(), itemId, acquiredAt: start, source, dye: null }),
  )
  return { ...state, holdings: { ...state.holdings, inventory } }
}

/** The player wearing the first item they own as their sigil. */
const wearing = (...itemIds: ReadonlyArray<string>): PlayerState => {
  const state = owning(...itemIds)
  const entryId = entryIds[0]
  if (entryId === undefined) return state
  return { ...state, holdings: { ...state.holdings, equipped: { sigil: entryId } } }
}

/** The XP a graded prompt's own grant carried, and the sigil it names. */
const promptGrants = (events: ReadonlyArray<ServerEventDraft>) =>
  events.flatMap((e) => (e.type === "xp.granted" && e.data.reason === "prompt.graded" ? [e.data] : []))

const happyPet: OwnedPet = {
  species: "fox",
  name: "Ember",
  hatchedAt: start,
  forms: [0],
  form: 0,
  mood: { value: 100, at: start },
}

const boosted = (state: PlayerState, ...boosts: ReadonlyArray<Boost>): PlayerState => ({
  ...state,
  progress: { ...state.progress, boosts: [...state.progress.boosts, ...boosts] },
})

const questBoost = (pct: number, source = "test/one"): Boost => ({
  kind: "quest",
  source,
  xpBoostPct: pct,
  endsAt: minutesLater(60),
})

describe("sigils: pricing", () => {
  it("multiplies a graded prompt's XP by the sigil worn: 10 XP with a ×2 sigil earns 20, and says so", () => {
    const { events } = play([prompt(5)], wearing("arcane-sigil"))
    expect(promptGrants(events)).toEqual([
      { amount: 20, tier: "reported", reason: "prompt.graded", totalAfter: 30, grade: 5, sigil: 2 },
    ])
    expect(promptGrants(play([prompt(5)], owning("arcane-sigil")).events)).toEqual([
      { amount: 10, tier: "reported", reason: "prompt.graded", totalAfter: 20, grade: 5 },
    ])
  })

  it("prices base, band, sigil, then x (1 + the flat boosts), rounded down once: 10 XP, x2, +15% earns 23", () => {
    // A happy pet's 5% and a mission's 10%.
    const state = boosted(
      { ...wearing("arcane-sigil"), holdings: { ...wearing("arcane-sigil").holdings, pet: happyPet } },
      questBoost(10),
    )
    expect(promptGrants(play([prompt(5)], state).events).map((grant) => grant.amount)).toEqual([23])
    // A grade of 4.143 is 8.286 XP; a Chalk Sigil's ×1.2 makes it 9.943, and +15% 11.43: rounded down once that is
    // 11, where rounding after the sigil too would give 9, then 10.
    const chalk = boosted(
      { ...wearing("chalk-sigil"), holdings: { ...wearing("chalk-sigil").holdings, pet: happyPet } },
      questBoost(10),
    )
    const uneven = prompt(4, 0, { ...flat(4), focus: 5 })
    expect(promptGrants(play([uneven], chalk).events).map((grant) => grant.amount)).toEqual([11])
  })

  it("applies the day's band before the sigil: the 21st prompt's 5 XP earns 10 with a ×2 sigil", () => {
    const prompts = Array.from({ length: 21 }, (_, i) => prompt(5, i))
    const amounts = promptGrants(play(prompts, wearing("arcane-sigil")).events).map((grant) => grant.amount)
    expect(amounts.slice(19)).toEqual([20, 10])
  })

  it("rewards quality, not volume: with a ×2.5 legendary, a vague 2 XP prompt earns 5, a clear 18 XP one 45", () => {
    const { events } = play([prompt(1), prompt(9, 1)], wearing("wyrm-sigil"))
    const amounts = promptGrants(events).map((grant) => grant.amount)
    expect(amounts).toEqual([5, 45])
  })

  it("multiplies prompt XP only: a commit, the streak and a mission's XP stay as they are", () => {
    const { events } = play([commit()], wearing("wyrm-sigil"))
    const grants = events.flatMap((e) =>
      e.type === "xp.granted" ? [[e.data.reason, e.data.amount, e.data.sigil]] : [],
    )
    expect(grants).toEqual([
      ["streak.day", 10, undefined],
      ["commit.made", 3, undefined],
    ])
  })

  it("counts only the sigil worn: more owned add nothing, a better one swapped in counts, and none is x1", () => {
    const owned = owning("chalk-sigil", "storm-sigil", "dawn-sigil")
    const [chalk, storm] = entryIds
    if (chalk === undefined || storm === undefined) throw new Error("no entry ids")
    const inputs = [prompt(5), equip(chalk), prompt(5, 1), equip(storm), prompt(5, 2), unequip(), prompt(5, 3)]
    const { state, events } = play(inputs, owned)
    expect(promptGrants(events).map((grant) => [grant.amount, grant.sigil])).toEqual([
      [10, undefined],
      [12, 1.2],
      [22, 2.2],
      [10, undefined],
    ])
    // The old sigil stays in the inventory after the swap; the slot is empty after the unequip.
    expect(state.holdings.inventory.map((entry) => entry.id)).toEqual(expect.arrayContaining(entryIds))
    expect(state.holdings.equipped).toEqual({})
  })

  it("gives each rarity more than the one below on a 10 XP prompt: epic's best earns 22, legendary's least 23", () => {
    const amounts = ["storm-sigil", "dawn-sigil"].map(
      (itemId) => promptGrants(play([prompt(5)], wearing(itemId)).events)[0]?.amount,
    )
    expect(amounts).toEqual([22, 23])
  })

  it("never lets adjacent rarities' ranges earn the same XP on a prompt worth 10 to 20 XP", () => {
    const ranges = starterRules.prompt.sigilMultiplier
    const rarities: ReadonlyArray<Rarity> = ["common", "uncommon", "rare", "epic", "legendary"]
    for (let thousandths = 10_000; thousandths <= 20_000; thousandths += 1) {
      for (const [i, rarity] of rarities.entries()) {
        const next = rarities[i + 1]
        if (next === undefined) continue
        const top = Math.floor(Math.round(thousandths * ranges[rarity][1]) / 1000)
        const bottom = Math.floor(Math.round(thousandths * ranges[next][0]) / 1000)
        expect(top).toBeLessThan(bottom)
      }
    }
  })
})

describe("sigils: the catalogue in force", () => {
  const retuned = (multiplier: number): ReadonlyArray<ItemDef> =>
    starterCatalog.map((item) =>
      item.id === "arcane-sigil" && item.sigil !== undefined ? { ...item, sigil: { ...item.sigil, multiplier } } : item,
    )

  it("prices a replay at the multiplier the catalogue in force gives the sigil worn then, as rules reprice", () => {
    const owned = owning("arcane-sigil")
    const [arcane] = entryIds
    if (arcane === undefined) throw new Error("no entry ids")
    const inputs = [prompt(5), equip(arcane), prompt(5, 1), unequip(), prompt(5, 2)]
    const live = play(inputs, owned)
    expect(promptGrants(live.events).map((grant) => grant.amount)).toEqual([10, 20, 10])
    const recorded = live.steps.map((s) => ({ rolls: s.rolls, refusal: s.refusal }))
    const again = replay(inputs, recorded, owned, { catalog: retuned(2.2) })
    expect(promptGrants(again.events).map((grant) => grant.amount)).toEqual([10, 22, 10])
    // A catalogue that dropped the sigil prices it at nothing extra, though the entry stays worn.
    const catalog = starterCatalog.filter((item) => item.id !== "arcane-sigil")
    const gone = replay(inputs, recorded, owned, { catalog })
    expect(promptGrants(gone.events).map((grant) => grant.amount)).toEqual([10, 10, 10])
  })

  it("holds a sigil to its rarity's range in the rules, so a catalogue out of step never pays more", () => {
    expect(equippedSigil(wearing("arcane-sigil"), { rules: starterRules, catalog: retuned(3) })).toBe(2.2)
    const lower: RulesConfig = {
      ...starterRules,
      prompt: {
        ...starterRules.prompt,
        sigilMultiplier: { ...starterRules.prompt.sigilMultiplier, epic: [2.05, 2.2] },
      },
    }
    expect(Schema.is(RulesSchema)(lower)).toBe(true)
    expect(equippedSigil(wearing("arcane-sigil"), { rules: lower, catalog: starterCatalog })).toBe(2.05)
  })

  it("equips only into the sigil slot, and the snapshot carries the sigil worn and its definition", () => {
    const owned = owning("arcane-sigil", "wizard-hat")
    const [arcane, hat] = entryIds
    if (arcane === undefined || hat === undefined) throw new Error("no entry ids")
    const wrong = command({ id: nextId(), type: "item.equip", data: { entryId: arcane, slot: "aura" } })
    const hatThere = command({ id: nextId(), type: "item.equip", data: { entryId: hat, slot: "sigil" } })
    const { state, steps } = play([wrong, hatThere, equip(arcane)], owned)
    expect(steps.map((s) => s.refusal?.code ?? null)).toEqual(["invalid", "invalid", null])
    const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    const snapshot = project(state, { rules: starterRules, catalog: starterCatalog, questPacks: [], now: start }, meta)
    expect(snapshot.character.equipped).toEqual({ sigil: arcane })
    expect(snapshot.items.find((item) => item.id === "arcane-sigil")?.sigil).toEqual({
      multiplier: 2,
      glyph: "✹",
      color: "#c77dff",
    })
  })
})

describe("sigils: drops only", () => {
  const pity = { sinceRare: 0, sinceEpic: 0 }
  const shared = (share: number): RulesConfig => ({
    ...starterRules,
    loot: {
      ...starterRules.loot,
      sigilShare: { common: share, uncommon: share, rare: share, epic: share, legendary: share },
    },
  })
  const drops = (rules: RulesConfig, count: number) =>
    Array.from({ length: count }, (_, n) =>
      rollLoot("seed", n, 1, rules, starterCatalog, pity, rules.loot.weights, "epic"),
    )

  it("makes a sigil the share of a rarity's drops the rules say", () => {
    expect(drops(shared(1), 50).every((drop) => drop !== null && isSigil(drop.item))).toBe(true)
    expect(drops(shared(0), 50).some((drop) => drop === null || isSigil(drop.item))).toBe(false)
    const sigils = drops(starterRules, 4000).filter((drop) => drop !== null && isSigil(drop.item)).length
    expect(sigils / 4000).toBeGreaterThan(0.015)
    expect(sigils / 4000).toBeLessThan(0.05)
  })

  it("can drop from a prompt, a level-up and a mission's reward, like any loot", () => {
    const pack: QuestPack = {
      id: "test",
      version: 1,
      title: "Test quests",
      quests: [
        {
          id: "commit-once",
          title: "Commit Once",
          cadence: "daily",
          goal: { kind: "fact", fact: "commit.made", count: 1 },
          rewards: { loot: { rarity: "rare" } },
        },
      ],
    }
    const always: RulesConfig = {
      ...shared(1),
      loot: { ...shared(1).loot, promptChanceAtTen: 1 },
      missions: { ...starterRules.missions, daily: { count: 1, tier: "uncommon" } },
      questPacks: ["test"],
    }
    const categories = (state: PlayerState) =>
      state.holdings.inventory.map((entry) => starterCatalog.find((item) => item.id === entry.itemId)?.category)
    expect(categories(play([prompt(10)], fresh(), { rules: always }).state)).toEqual(["sigil"])
    const state = fresh()
    // 95 XP and the streak's 10 reach level 1; the commit completes the mission.
    const nearOne = { ...state, progress: { ...state.progress, xp: { verified: 0, reported: 95 } } }
    const { steps } = play([commit()], nearOne, { rules: always, packs: [pack] })
    expect(steps[0]?.rolls.map((roll) => roll.trigger)).toEqual(["levelUp", "reward"])
    expect(categories(steps[0]?.state ?? fresh())).toEqual(["sigil", "sigil"])
  })

  it("is never handed out by a quest that names one or a sigil pool: the reward rolls, a sigil at the usual share", () => {
    const pack = (loot: QuestPack["quests"][number]["rewards"]["loot"]): QuestPack => ({
      id: "test",
      version: 1,
      title: "Test quests",
      quests: [
        {
          id: "commit-once",
          title: "Commit Once",
          cadence: "daily",
          goal: { kind: "fact", fact: "commit.made", count: 1 },
          rewards: loot === undefined ? {} : { loot },
        },
      ],
    })
    const rules: RulesConfig = {
      ...shared(0),
      missions: { ...starterRules.missions, daily: { count: 1, tier: "uncommon" } },
      questPacks: ["test"],
    }
    const rewarded = (loot: NonNullable<QuestPack["quests"][number]["rewards"]["loot"]>) => {
      const { state } = play([commit()], fresh(), { rules, packs: [pack(loot)] })
      return state.holdings.inventory.map((entry) => starterCatalog.find((item) => item.id === entry.itemId))
    }
    const named = rewarded({ rarity: "rare", item: "wyrm-sigil" })
    expect(named.map((item) => [item?.rarity, item !== undefined && isSigil(item)])).toEqual([["rare", false]])
    const pooled = rewarded({ rarity: "epic", pool: "sigil" })
    expect(pooled.map((item) => [item?.rarity, item !== undefined && isSigil(item)])).toEqual([["epic", false]])
    // A named item that is no sigil still lands as named.
    expect(rewarded({ rarity: "common", item: "wizard-hat" }).map((item) => item?.id)).toEqual(["wizard-hat"])
  })

  it("is never made by a shard craft, which refuses one; nor by a re-roll or the shop, which are not built yet", () => {
    const craft = (itemId: string) => command({ id: nextId(), type: "shards.craft", data: { rarity: "epic", itemId } })
    const reroll = command({ id: nextId(), type: "item.reroll", data: { entryId: entryIds[0] ?? "" } })
    const buy = command({ id: nextId(), type: "shop.buy", data: { offerId: "arcane-sigil" } })
    const { steps, state } = play([craft("arcane-sigil"), craft("pixel-dragon"), reroll, buy], wearing("arcane-sigil"))
    expect(steps.map((s) => [s.refusal?.code, s.refusal?.message])).toEqual([
      ["not_allowed", "A sigil only drops: shards can't craft one"],
      ["not_allowed", "Not available in this version yet"],
      ["not_allowed", "Not available in this version yet"],
      ["not_allowed", "Not available in this version yet"],
    ])
    expect(state).toEqual(wearing("arcane-sigil"))
  })

  it("can be granted by the dev command, marked dev", () => {
    const grant = command({ id: nextId(), type: "dev.grantItem", data: { itemId: "wyrm-sigil" } })
    const result = step(fresh(), grant, { ...contextAt(1, start), dev: true })
    expect(result.state.holdings.inventory).toMatchObject([{ itemId: "wyrm-sigil", source: { kind: "dev" } }])
    expect(result.events).toMatchObject([
      { type: "loot.dropped", data: { item: { id: "wyrm-sigil" }, tier: "legendary" } },
    ])
  })
})

describe("sigils: the starter set", () => {
  it("has two at every rarity, each inside its range, drawn with a one-cell mark and a color", () => {
    const sigils = starterCatalog.filter(isSigil)
    for (const item of sigils) expect(Schema.decodeUnknownSync(ItemDefSchema)(item)).toEqual(item)
    const counts = new Map<string, number>()
    for (const item of sigils) counts.set(item.rarity, (counts.get(item.rarity) ?? 0) + 1)
    expect(Object.fromEntries(counts)).toEqual({ common: 2, uncommon: 2, rare: 2, epic: 2, legendary: 2 })
    expect(catalogIssue(starterRules.prompt.sigilMultiplier, starterCatalog)).toBe(undefined)
    expect(sigils.map((item) => [...(item.sigil?.glyph ?? "")].length)).toEqual(sigils.map(() => 1))
  })

  it("steepens the curve for sigils, keeping level 1 at 100 XP and asking more for every level after", () => {
    const before = { base: 100, exponent: 1.6 }
    expect(xpForLevel(starterRules.levelCurve, 1)).toBe(100)
    for (let level = 2; level <= 120; level++) {
      expect(xpForLevel(starterRules.levelCurve, level)).toBeGreaterThan(xpForLevel(before, level))
    }
    expect(xpForLevel(starterRules.levelCurve, 10)).toBe(4570)
    expect(xpForLevel(starterRules.levelCurve, 100)).toBe(208929)
  })
})

describe("mission XP boosts", () => {
  const boostPack: QuestPack = {
    id: "test",
    version: 1,
    title: "Test quests",
    quests: [
      {
        id: "commit-once",
        title: "Commit Once",
        cadence: "daily",
        goal: { kind: "fact", fact: "commit.made", count: 1 },
        rewards: { xp: 50, xpBoost: { pct: 10, minutes: 60 } },
      },
    ],
  }
  const rules: RulesConfig = {
    ...starterRules,
    missions: { ...starterRules.missions, daily: { count: 1, tier: "uncommon" } },
    questPacks: ["test"],
  }

  it("starts when the mission completes and adds its percent after the sigil, for its minutes", () => {
    const { state, events } = play([commit(), prompt(5, 30), prompt(5, 61)], wearing("arcane-sigil"), {
      rules,
      packs: [boostPack],
    })
    // The mission's own 50 XP is flat; the prompts' 20 XP earn 22 within the hour, and 20 after it.
    const quest = events.flatMap((e) => (e.type === "xp.granted" && e.data.reason === "quest" ? [e.data.amount] : []))
    expect(quest).toEqual([50])
    expect(promptGrants(events).map((grant) => grant.amount)).toEqual([22, 20])
    expect(events.find((e) => e.type === "quest.completed")).toMatchObject({
      data: { rewards: { xpBoost: { pct: 10, minutes: 60 } } },
    })
    // Pruned once over.
    expect(state.progress.boosts).toEqual([])
  })

  it("never stacks two mission boosts, but adds one to food's and a happy pet's", () => {
    const two = boosted(fresh(), questBoost(10, "test/one"), questBoost(20, "test/two"))
    expect(promptGrants(play([prompt(5)], two).events).map((grant) => grant.amount)).toEqual([12])
    const food: Boost = { kind: "food", source: "trail-mix", xpBoostPct: 10, endsAt: minutesLater(60) }
    const both = boosted(fresh(), questBoost(20), food)
    expect(promptGrants(play([prompt(5)], both).events).map((grant) => grant.amount)).toEqual([13])
  })

  it("shows on the snapshot while it runs, and replays as the live run went", () => {
    const inputs = [commit(), prompt(5, 30)]
    const live = play(inputs, fresh(), { rules, packs: [boostPack] })
    const player = { id: session, githubUserId: null, githubLogin: null, displayName: "Player", createdAt: start }
    const meta = { player, serverId: "local", streamEpoch: 1, cursor: 0 }
    const context = { rules, catalog: starterCatalog, questPacks: [boostPack], now: minutesLater(30) }
    expect(project(live.state, context, meta).boosts).toEqual([
      { kind: "quest", source: "test/commit-once", xpBoostPct: 10, endsAt: minutesLater(60) },
    ])
    const recorded = live.steps.map((s) => ({ rolls: s.rolls, refusal: s.refusal }))
    expect(replay(inputs, recorded, fresh(), { rules, packs: [boostPack] }).state).toEqual(live.state)
    for (const one of live.steps) expect(Schema.is(StepSchema)(one)).toBe(true)
  })

  it("comes with two of the starter's prompt missions", () => {
    const boosting = starterQuestPack.quests.flatMap((quest) =>
      quest.rewards.xpBoost === undefined ? [] : [[quest.id, quest.rewards.xpBoost]],
    )
    expect(boosting).toEqual([
      ["clear-thinker", { pct: 10, minutes: 60 }],
      ["wordsmith-week", { pct: 15, minutes: 120 }],
    ])
  })
})

describe("XP a curve change carries", () => {
  const carried = (amount: number): Input => ({
    kind: "system",
    event: { type: "xp.carried", amount, rulesVersion: 7 },
  })

  it("adds reported XP with no banner, the level kept where it was", () => {
    const state = fresh()
    const atThree = {
      ...state,
      progress: { ...state.progress, xp: { verified: 0, reported: xpForLevel({ base: 100, exponent: 1.6 }, 3) } },
      holdings: { ...state.holdings, peakLevel: 3 },
    }
    const amount = xpForLevel(starterRules.levelCurve, 3) - atThree.progress.xp.reported
    const result = step(atThree, carried(amount), contextAt(1, start))
    expect(result.events).toEqual([])
    expect(result.state.progress.xp.reported).toBe(xpForLevel(starterRules.levelCurve, 3))
    expect(levelOf(result.state, starterRules).level).toBe(3)
    const replaying: Context["mode"] = { kind: "replay", recorded: { rolls: [], refusal: null } }
    const again = step(atThree, carried(amount), contextAt(1, start, {}, replaying))
    expect(again.state).toEqual(result.state)
  })

  it("does just what the migration did, in a replay too: no missions rolled, no level-up, only the XP", () => {
    const pack: QuestPack = {
      id: "test",
      version: 1,
      title: "Test quests",
      quests: [
        {
          id: "commit-once",
          title: "Commit Once",
          cadence: "daily",
          goal: { kind: "fact", fact: "commit.made", count: 1 },
          rewards: { xp: 50 },
        },
      ],
    }
    const rules: RulesConfig = { ...starterRules, questPacks: ["test"] }
    const state = fresh()
    const replaying: Context["mode"] = { kind: "replay", recorded: { rolls: [], refusal: null } }
    // Missions due to roll, and enough XP carried to pass level 1, which was never reached.
    const result = step(state, carried(150), contextAt(1, start, { rules, packs: [pack] }, replaying))
    expect(result.events).toEqual([])
    expect(result.rolls).toEqual([])
    expect(result.state).toEqual({ ...state, progress: { ...state.progress, xp: { verified: 0, reported: 150 } } })
  })
})
