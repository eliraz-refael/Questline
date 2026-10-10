import type { BandFrame, BandLook, BandMark, BandSlot, ItemDef, Rarity, RulesConfig } from "@questline/schema"

// The starter config and catalogue a fresh local server begins with: the design doc's numbers. One deviation for
// the proof of concept: merges are reported XP until the verifier lands, so the loop has its big moment.

export const starterRules: RulesConfig = {
  version: 5,
  schemaVersion: 4,
  appliesFrom: null,
  levelCurve: { base: 100, exponent: 1.6 },
  titles: [
    { fromLevel: 1, title: "Apprentice" },
    { fromLevel: 10, title: "Adept" },
    { fromLevel: 25, title: "Artisan" },
    { fromLevel: 50, title: "Master" },
    { fromLevel: 75, title: "Grandmaster" },
    { fromLevel: 100, title: "Legend" },
  ],
  // The emoji carry their selector, so every terminal draws them two cells wide; the mod pads ⚔ to the same two.
  glyphs: [
    { fromLevel: 0, glyph: "⚔" },
    { fromLevel: 5, glyph: "🗡️" },
    { fromLevel: 10, glyph: "🛡️" },
    { fromLevel: 15, glyph: "👑" },
    { fromLevel: 20, glyph: "🐉" },
  ],
  xp: {
    "change.merged": { xp: 250, tier: "reported", dailyCap: null, ownRepoXp: 120, tinyDiffPct: 25 },
    "change.opened": { xp: 0, tier: "reported", dailyCap: null },
    "commit.made": { xp: 3, tier: "reported", dailyCap: 20 },
    "review.acted_on": { xp: 80, tier: "verified", dailyCap: 10 },
    "issue.closed": { xp: 60, tier: "verified", dailyCap: 5 },
    "bug.fixed": { xp: 150, tier: "verified", dailyCap: 5 },
    "first.contribution": { xp: 300, tier: "verified", dailyCap: null },
    "tests.green": { xp: 20, tier: "reported", dailyCap: 5 },
    "repo.explored": { xp: 25, tier: "reported", dailyCap: 3 },
    "streak.day": { xp: 10, tier: "reported", dailyCap: 1 },
  },
  loot: {
    chancePerTurn: 0.12,
    // 12% at an average grade of 5, the turn's chance; 24% at 10. A grade of 9 or more doubles rare and better.
    promptChanceAtTen: 0.24,
    promptGreatAt: 9,
    promptGreatRareFactor: 2,
    chanceOnVerified: 1,
    weights: { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 },
    onLevelUp: { weights: { common: 50, uncommon: 30, rare: 15, epic: 4, legendary: 1 } },
    pity: { rareAfter: 25, epicAfter: 80 },
    gold: { common: 10, uncommon: 25, rare: 70, epic: 175, legendary: 400 },
    shardsToCraft: 10,
    salvageShards: { common: 1, uncommon: 1, rare: 1, epic: 1, legendary: 1 },
    rerollGold: { common: 20, uncommon: 50, rare: 120, epic: 300, legendary: 800 },
  },
  pet: { moodDecayPerDay: 10, happyAbove: 70, happyXpBonusPct: 5, evolveAt: [10, 25, 50] },
  streak: { xpPerDay: 10, maxXp: 70, restDaysPerWeek: 1 },
  prompt: {
    rubricVersion: 1,
    // Equal weights: the plain average of the quality scores, so a perfect grade earns maxXp.
    weights: { clarity: 1, grammar: 1, specificity: 1, instructive: 1, context: 1, doneCriteria: 1, focus: 1 },
    maxXp: 20,
    perDay: [
      { upTo: 20, pct: 100 },
      { upTo: 40, pct: 50 },
      { upTo: null, pct: 10 },
    ],
    // Haiku scores a regret of 1 or 2 on many a prompt that walks nothing back.
    regretAt: 5,
  },
  catalogVersion: 2,
  questPacks: [],
}

const item = (def: Pick<ItemDef, "id" | "name" | "rarity" | "category" | "slot"> & Partial<ItemDef>): ItemDef => ({
  sprite: null,
  lore: null,
  effect: null,
  look: null,
  ...def,
})

/** A band style: a look for one band slot, still unless it has frames. */
const style = (
  id: string,
  name: string,
  rarity: Rarity,
  slot: BandSlot,
  look: Pick<BandLook, "glyphs" | "colors"> & Partial<BandLook>,
  lore: string | null = null,
): ItemDef => item({ id, name, rarity, category: "bandStyle", slot, lore, look: { frames: null, fps: null, ...look } })

const white = "#ffffff"

/**
 * A sheen sweeping the track: `steps` frames carry its cells (`colors`, the middle one brightest) from one end to the
 * other, then `rest` frames without it; `accent` adds what each frame does to the slot's accents.
 */
const sweep = (
  steps: number,
  rest: number,
  colors: ReadonlyArray<string>,
  accent: (i: number) => Omit<BandFrame, "marks"> = () => ({}),
): Array<BandFrame> =>
  Array.from({ length: steps + rest }, (_, i) => {
    const at = Math.round((i / (steps - 1)) * 1000) / 1000
    const middle = Math.floor(colors.length / 2)
    const marks: Array<BandMark> = colors.map((color, j) => ({ at, dx: j - middle, color }))
    return i < steps ? { ...accent(i), marks } : accent(i)
  })

/** Twinkles at fixed places along the track, each running `glyphs` out of step with its neighbours. */
const twinkle = (
  places: ReadonlyArray<number>,
  glyphs: ReadonlyArray<string>,
  colors: ReadonlyArray<string>,
  accent: (i: number) => Omit<BandFrame, "marks"> = () => ({}),
): Array<BandFrame> =>
  Array.from({ length: glyphs.length }, (_, i) => ({
    ...accent(i),
    marks: places.flatMap((at, j) => {
      const phase = (i + j * 3) % glyphs.length
      const glyph = glyphs[phase]
      const color = colors[phase % colors.length] ?? white
      return glyph === undefined || glyph === " " ? [] : [{ at, glyph, color }]
    }),
  }))

/** One value per frame from a short cycle. */
const pick = (values: ReadonlyArray<string>, i: number): string => values[i % values.length] ?? white

// The band styles, a few per rarity. Common to rare are still: other glyphs and color themes. Epic and legendary
// loop: a sheen along the XP bar, stars along the edge, a glint on the gold.
const bandStyles: ReadonlyArray<ItemDef> = [
  style("solid-bar", "Solid Bar", "common", "xpBar", {
    glyphs: { full: "█", empty: "░" },
    colors: { full: "#87d787", empty: "#4e4e4e" },
  }),
  style("double-rule", "Double Rule", "common", "topEdge", {
    glyphs: { line: "═", left: "╡", right: "╞", knot: "◇", dot: "═" },
    colors: {
      line: "#808080",
      left: "#a8a8a8",
      right: "#a8a8a8",
      star: "#d0d0d0",
      title: "#e4e4e4",
      knot: "#a8a8a8",
      dot: "#808080",
    },
  }),
  style("copper-purse", "Copper Purse", "common", "goldDisplay", {
    glyphs: { icon: "●" },
    colors: { icon: "#d7875f", amount: "#d7af87" },
  }),
  style("bead-string", "Bead String", "uncommon", "xpBar", {
    glyphs: { full: "●", empty: "○" },
    colors: { full: "#5fd7ff", empty: "#585858", label: "#87d7ff" },
  }),
  style("squires-plate", "Squire's Plate", "uncommon", "levelDisplay", {
    glyphs: { left: "⟦", right: "⟧" },
    colors: { level: "#5fd75f", left: "#87af87", right: "#87af87", title: "#afd7af" },
  }),
  style("meadow-rule", "Meadow Rule", "uncommon", "topEdge", {
    glyphs: { line: "╌", knot: "✧", dot: "╌" },
    colors: {
      line: "#5f875f",
      left: "#5f875f",
      right: "#5f875f",
      star: "#87d787",
      title: "#d7ffaf",
      knot: "#87d787",
      dot: "#5f875f",
    },
  }),
  style("tempered-steel", "Tempered Steel", "rare", "xpBar", {
    glyphs: { full: "━", empty: "╍", head: "╸" },
    colors: { full: "#4ea8ff", empty: "#303a4e", head: "#b8dcff", label: "#87afff" },
  }),
  style("sapphire-purse", "Sapphire Purse", "rare", "goldDisplay", {
    glyphs: { icon: "◆", spark: "✧" },
    colors: { icon: "#4ea8ff", amount: "#b8dcff", spark: "#87afff" },
  }),
  style("runic-crest", "Runic Crest", "rare", "levelDisplay", {
    glyphs: { lv: "ʟᴠ", left: "❮", right: "❯" },
    colors: { glyph: "#b8dcff", level: "#4ea8ff", title: "#87afff", left: "#5f87d7", right: "#5f87d7" },
  }),
  style(
    "arcane-current",
    "Arcane Current",
    "epic",
    "xpBar",
    {
      glyphs: { full: "▰", empty: "▱", head: "✦" },
      colors: { full: "#9d4edd", empty: "#3c2a4d", head: "#e0aaff", label: "#c77dff" },
      // A violet sheen runs the bar in under three seconds, then rests a second, the head twinkling throughout.
      frames: sweep(16, 6, ["#c77dff", "#e0aaff", white, "#e0aaff", "#c77dff"], (i) => ({
        glyphs: { head: pick(["✦", "✧", "⋆", "✧"], i) },
        colors: { head: pick(["#e0aaff", white, "#c77dff", white], i) },
      })),
      fps: 6,
    },
    "It hums when the tests go green.",
  ),
  style(
    "starlit-edge",
    "Starlit Edge",
    "epic",
    "topEdge",
    {
      glyphs: { star: "✦", knot: "✧" },
      colors: {
        line: "#5a4a78",
        left: "#7b6cf6",
        right: "#7b6cf6",
        star: "#c77dff",
        title: "#e0aaff",
        knot: "#9d8cff",
        dot: "#5a4a78",
      },
      // Stars come and go along the edge, out of step, while the two by the name trade places.
      frames: twinkle(
        [0.06, 0.19, 0.33, 0.47, 0.6, 0.74, 0.88],
        ["·", "⋆", "✧", "✦", "✧", "⋆", " ", " "],
        ["#9d8cff", "#c77dff", "#e0aaff", white],
        (i) => ({ glyphs: { star: pick(["✦", "✧"], Math.floor(i / 2)) } }),
      ),
      fps: 5,
    },
    "Cut from the night the first merge landed.",
  ),
  style(
    "starforged-bar",
    "Starforged Bar",
    "legendary",
    "xpBar",
    {
      glyphs: { full: "▰", empty: "▱", head: "✸" },
      colors: { full: "#ffb627", empty: "#4d3a12", head: "#fff1a8", label: "#ffd23f" },
      // Molten light runs the bar, the head flaring like a forge.
      frames: sweep(20, 4, ["#ff9f1c", "#ffd23f", white, "#ffd23f", "#ff9f1c"], (i) => ({
        glyphs: { head: pick(["✸", "✦", "✧", "✦"], i) },
        colors: { head: pick(["#fff1a8", white, "#ffd23f", white], i) },
      })),
      fps: 6,
    },
    "Hammered from a fallen star.",
  ),
  style(
    "dragons-hoard",
    "Dragon's Hoard",
    "legendary",
    "goldDisplay",
    {
      glyphs: { icon: "◈", spark: "✧" },
      colors: { icon: "#ffb627", amount: "#ffd23f", spark: "#fff1a8" },
      // The coin catches the light, and a spark winks beside the count.
      frames: Array.from({ length: 8 }, (_, i) => ({
        glyphs: {
          icon: pick(["◈",
          "◈",
          "◆",
          "◈",
          "◈",
          "◇",
          "◈",
          "◈"],
          i),
          spark: pick(["✧",
          "✦",
          "⋆",
          "·",
          "˚",
          "·",
          "⋆",
          "✦"],
          i),
        },
        colors: {
          icon: pick(["#ffb627", "#ffd23f", white, "#ffd23f", "#ffb627", "#ff9f1c", "#ffb627", "#ffd23f"], i),
          spark: pick(["#fff1a8", white, "#ffd23f", "#ff9f1c", "#ffd23f", "#fff1a8", white, "#fff1a8"], i),
        },
      })),
      fps: 4,
    },
    "Every coin remembers the quest that paid it.",
  ),
  style(
    "crown-of-ages",
    "Crown of Ages",
    "legendary",
    "levelDisplay",
    {
      glyphs: { left: "✧", right: "✧" },
      colors: { glyph: "#ffd23f", level: "#ffb627", title: "#ffe8a3", left: "#ffd23f", right: "#ffd23f" },
      // Stars either side of the level twinkle in turn.
      frames: Array.from({ length: 6 }, (_, i) => ({
        glyphs: {
          left: pick(["✧", "✦", "⋆", "✦", "✧", "·"], i),
          right: pick(["✦", "✧", "·", "✧", "✦", "⋆"], i),
        },
        colors: { left: pick([white, "#ffd23f", "#ffb627"], i), right: pick(["#ffb627", white, "#ffd23f"], i) },
      })),
      fps: 4,
    },
    "Worn by those who never break the streak.",
  ),
]

export const starterCatalog: ReadonlyArray<ItemDef> = [
  item({ id: "plain-cap", name: "Plain Cap", rarity: "common", category: "wearable", slot: "head" }),
  item({ id: "paper-scarf", name: "Paper Scarf", rarity: "common", category: "wearable", slot: "neck" }),
  item({
    id: "trail-mix",
    name: "Trail Mix",
    rarity: "common",
    category: "food",
    slot: null,
    effect: { xpBoostPct: 10, minutes: 60 },
  }),
  item({ id: "knit-scarf", name: "Knit Scarf", rarity: "uncommon", category: "wearable", slot: "neck" }),
  item({ id: "confetti-pop", name: "Confetti Pop", rarity: "uncommon", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({ id: "terminal-green", name: "Terminal Green", rarity: "uncommon", category: "scene", slot: "scene" }),
  item({ id: "wizard-hat", name: "Wizard Hat", rarity: "rare", category: "wearable", slot: "head" }),
  item({ id: "fireworks", name: "Fireworks", rarity: "rare", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({ id: "pixel-dragon", name: "Pixel Dragon", rarity: "epic", category: "levelUpEffect", slot: "levelUpEffect" }),
  item({
    id: "aurora-crown",
    name: "Aurora Crown",
    rarity: "legendary",
    category: "artefact",
    slot: "aura",
    lore: "Said to glow brighter with every merge.",
  }),
  ...bandStyles,
]
