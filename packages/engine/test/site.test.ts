import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { starterRules as rules, titleFor, xpForLevel } from "../src/index.ts"

// The landing page hard-codes the rules' numbers in plain HTML, so a change to the rules has to reach it too. Each
// test reads the numbers back out of site/index.html and checks them against the starter rules.

const site = readFileSync(new URL("../../../site/index.html", import.meta.url), "utf8")

const fmt = (n: number): string => n.toLocaleString("en-US")
const matches = (pattern: RegExp): ReadonlyArray<RegExpMatchArray> => [...site.matchAll(pattern)]
const one = (pattern: RegExp): RegExpMatchArray => {
  const found = matches(pattern)
  expect(found, String(pattern)).toHaveLength(1)
  return found[0]!
}
const level = (n: number) => xpForLevel(rules.levelCurve, n)

describe("the landing page's path", () => {
  const stops = matches(
    /<div class="stop[^"]*"><div class="node">(\d+)<\/div><h3>([^<]+)<\/h3><span class="need">([\d,]+) XP<\/span>(<span class="evolve">)?/g,
  )

  it("has a stop at each title, and only there", () => {
    expect(stops.map(([, n]) => Number(n))).toEqual(rules.titles.map((t) => t.fromLevel))
  })

  it("names each stop's title and XP as the rules do", () => {
    for (const [, n, title, need] of stops) {
      expect({ title, need }).toEqual({ title: titleFor(rules, Number(n)), need: fmt(level(Number(n))) })
    }
  })

  it("marks the pet evolving at exactly the rules' levels", () => {
    expect(stops.filter(([, , , , evolve]) => evolve !== undefined).map(([, n]) => Number(n))).toEqual(
      rules.pet.evolveAt,
    )
  })
})

describe("the landing page's band", () => {
  const [, levelText, titleText] = one(/<span class="t-title">Lv (\d+) · ([^<]+)<\/span> <span class="t-edge">╞═+◇═+<\/span>\n/g)
  const shown = Number(levelText)
  const [, from, to] = one(/const lv = \{ from: (\d+), to: (\d+) \};/g)
  const [, start, end] = one(/await animateXp\((\d+), (\d+)\);/g)
  const [, idle] = one(/band\.innerHTML = bandAt\((\d+)\);/g)
  const [, still, stillTo] = one(/<span class="t-dim">([\d,]+) \/ ([\d,]+)<\/span>/g)

  it("spans the shown level, with its title", () => {
    expect({ from: Number(from), to: Number(to), title: titleText }).toEqual({
      from: level(shown),
      to: level(shown + 1),
      title: titleFor(rules, shown),
    })
  })

  it("animates within that level, and the still frame shows where it ends", () => {
    expect(Number(idle)).toBe(Number(start))
    expect(Number(start)).toBeGreaterThanOrEqual(level(shown))
    expect(Number(end)).toBeLessThan(level(shown + 1))
    expect({ still, stillTo }).toEqual({ still: fmt(Number(end)), stillTo: fmt(level(shown + 1)) })
  })
})

describe("the landing page's loot odds", () => {
  const total = Object.values(rules.loot.weights).reduce((a, b) => a + b, 0)
  const pct = (weight: number) => String(Math.round((weight / total) * 1000) / 10)
  const tiers = matches(/<span class="tier-name">(\w+)<\/span><span class="tier-pct">([\d.]+)<small>%/g)

  it("shows each rarity's base odds", () => {
    expect(Object.fromEntries(tiers.map(([, name, shown]) => [name!.toLowerCase(), shown]))).toEqual(
      Object.fromEntries(Object.entries(rules.loot.weights).map(([rarity, weight]) => [rarity, pct(weight)])),
    )
  })

  it("says the same odds in the chart's label", () => {
    const label = Object.entries(rules.loot.weights).map(([rarity, weight]) => `${rarity} ${pct(weight)}%`)
    expect(site).toContain(`aria-label="Base drop odds: ${label.join(", ")}"`)
  })

  it("gives the drop chance at a grade of 5 and of 10", () => {
    const [, at5, at10] = one(/(\d+)% of the time at an average grade of 5, rising to (\d+)% at a perfect 10/g)
    expect([Number(at5), Number(at10)]).toEqual([rules.loot.chancePerTurn * 100, rules.loot.promptChanceAtTen * 100])
  })
})

describe("the landing page's prompt XP", () => {
  it("tapers as the rules' day does", () => {
    const shown = matches(/<div><b>(\d+)%<\/b><span>(?:prompts \d+ to (\d+)|after that)<\/span><\/div>/g)
    expect(shown.map(([, pct, upTo]) => ({ upTo: upTo === undefined ? null : Number(upTo), pct: Number(pct) }))).toEqual(
      rules.prompt.perDay,
    )
  })

  it("tops out at the rules' maximum", () => {
    expect(one(/<h3>Up to (\d+) XP a prompt<\/h3>/g)[1]).toBe(String(rules.prompt.maxXp))
  })
})

describe("the landing page's XP table", () => {
  // Each row's text, keyed by the event type it shows.
  const rows: Record<keyof typeof rules.xp, string> = {
    "first.contribution": "First contribution to a repo",
    "change.merged": "Pull request merged",
    "bug.fixed": "Bug fixed",
    "review.acted_on": "Review feedback acted on",
    "issue.closed": "Issue closed",
    "repo.explored": "New repo explored",
    "tests.green": "Red tests turned green",
    "streak.day": "Streak day",
    "commit.made": "Commit",
    "change.opened": "Pull request opened",
  }
  const cap = (dailyCap: number | null) => (dailyCap === null ? "none" : `${dailyCap} a day`)

  it("lists every XP source the rules pay, with its cap, XP and GitHub check", () => {
    for (const [type, text] of Object.entries(rows) as Array<[keyof typeof rules.xp, string]>) {
      const source = rules.xp[type]
      const [, gh, shownCap, shownXp] = one(
        new RegExp(`<td class="what">${text}( <span class="gh">GitHub</span>)?(?:<small>[^<]*</small>)?</td><td class="cap">([^<]+)</td><td class="xp">(\\d+)</td>`, "g"),
      )
      expect({ type, github: gh !== undefined, cap: shownCap, xp: Number(shownXp) }).toEqual({
        type,
        github: source.tier === "verified",
        cap: cap(source.dailyCap),
        xp: source.xp,
      })
    }
  })

  it("covers every XP source", () => {
    expect(Object.keys(rows).sort()).toEqual(Object.keys(rules.xp).sort())
  })
})

describe("the landing page's pet facts", () => {
  it("states the rules' happy bonus, threshold and daily drift", () => {
    expect(one(/<b>\+(\d+)%<\/b><span>XP while your pet is happy\. Keep its mood above (\d+)\./g).slice(1)).toEqual([
      String(rules.pet.happyXpBonusPct),
      String(rules.pet.happyAbove),
    ])
    expect(one(/<b>−(\d+)<\/b><span>mood for every day/g)[1]).toBe(String(rules.pet.moodDecayPerDay))
    expect(one(/<b>(\d+)<\/b><span>rest day a week/g)[1]).toBe(String(rules.streak.restDaysPerWeek))
  })
})
