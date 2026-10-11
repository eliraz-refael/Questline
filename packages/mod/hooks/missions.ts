import type { QuestState, RulesConfig, Snapshot } from '@questline/schema'
import type { MissionRewards, MissionsView, MissionView, Tier } from '../types'
import { tierOf } from './celebrate'
import type { Row, Run } from './cells'
import { blank, cellsOf, cellsOfRow, clip, dim } from './cells'
import { rarityColors } from './frames'
import { boostText } from './sigils'
import { counted, fitting, meter } from './stats'

// Missions, the daily and weekly quests, as the pane's Missions tab and the band's row 2 show them. The server rolls
// them, counts their progress and grants their rewards; this file only reads the snapshot's quest states and the
// rules beside them, and lays them out as rows of styled runs that register.tsx draws, with its buttons beside them.

const statuses: ReadonlyArray<MissionView['status']> = ['offered', 'active', 'completed', 'expired']

const rewardsOf = (rewards: QuestState['rewards']): MissionRewards => {
  const boost = rewards.xpBoost
  return {
    xp: rewards.xp ?? 0,
    gold: rewards.gold ?? 0,
    loot: rewards.loot === undefined ? null : tierOf(rewards.loot.rarity),
    // A server older than boosts sends none.
    ...(typeof boost?.pct === 'number' && typeof boost.minutes === 'number'
      ? { boost: { pct: boost.pct, minutes: boost.minutes } }
      : {}),
  }
}

const instantOf = (iso: string | null): number | null => {
  const at = iso === null ? Number.NaN : Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

/**
 * The missions the snapshot carries, with how many weeklies may run at once and each cadence's tier from the rules. A
 * server older than missions sends no `missions` in its rules: the tab says so, the band shows none, and the pane
 * offers no dev controls for them. Its snapshot's `quests` can't tell, as servers sent an empty list from the start.
 */
export const missionsViewOf = (snapshot: Snapshot, rules: Partial<RulesConfig>): MissionsView => {
  const states: ReadonlyArray<QuestState> | null = Array.isArray(snapshot.quests) ? snapshot.quests : null
  const isKnown = typeof rules.missions === 'object' && rules.missions !== null && states !== null
  const missions: Partial<RulesConfig['missions']> = rules.missions ?? {}
  const quests = (states ?? []).flatMap((quest): Array<MissionView> => {
    const status = statuses.find((one) => one === quest.status)
    if (status === undefined) return []
    return [
      {
        questId: quest.questId,
        title: quest.title,
        description: quest.description ?? null,
        cadence: quest.cadence,
        status,
        progress: quest.progress,
        goal: quest.goal,
        goalKind: typeof quest.goalKind === 'string' ? quest.goalKind : null,
        rewards: rewardsOf(quest.rewards ?? {}),
        expiresAt: instantOf(quest.expiresAt ?? null),
      },
    ]
  })
  return {
    isKnown,
    quests,
    weeklyActive: typeof missions.weekly?.active === 'number' ? missions.weekly.active : null,
    tiers: {
      daily: missions.daily === undefined ? null : tierOf(missions.daily.tier),
      weekly: missions.weekly === undefined ? null : tierOf(missions.weekly.tier),
    },
  }
}

/** A cadence's color: the tier its missions celebrate at, as loot's; the accent when the rules don't say. */
export const cadenceColor = (missions: MissionsView, cadence: string): string => {
  const { daily, weekly } = missions.tiers
  const tier: Tier | null = cadence === 'daily' ? daily : cadence === 'weekly' ? weekly : null
  return tier === null ? 'claude' : rarityColors[tier]
}

const shareOf = (mission: MissionView): number =>
  mission.goal <= 0 ? 0 : Math.max(0, Math.min(1, mission.progress / mission.goal))

const isRunning = (mission: MissionView): boolean => mission.status === 'active' && mission.progress < mission.goal

/** Whether the server names each mission's goal, which only one that knows parallel missions does. */
export const knowsTogether = (missions: MissionsView | null): boolean =>
  (missions?.quests ?? []).some((one) => one.goalKind !== null)

/** A mission whose goal counts moments sessions ran together. */
export const isTogether = (mission: MissionView): boolean => mission.goalKind === 'parallel'

/** A mission's count, as `3/5`, or `2 of 3 together` for moments sessions ran together. */
const countOf = (mission: MissionView): string =>
  isTogether(mission)
    ? `${counted(mission.progress)} of ${counted(mission.goal)} together`
    : `${counted(mission.progress)}/${counted(mission.goal)}`

/**
 * Whether the band may show a running mission. One over sessions run together shows only once it has a moment: the
 * band reports what happened, and never suggests opening more sessions.
 */
const isBandWorthy = (mission: MissionView): boolean =>
  isRunning(mission) && (!isTogether(mission) || mission.progress > 0)

/**
 * The missions as of clock `now`: one still running or on offer whose window has ended reads as expired, as the
 * server would say, so a band or a pane left open past midnight never shows yesterday's as running.
 */
export const missionsAt = (missions: MissionsView, now: number): MissionsView => ({
  ...missions,
  quests: missions.quests.map((one) =>
    (one.status === 'active' || one.status === 'offered') && one.expiresAt !== null && one.expiresAt <= now
      ? { ...one, status: 'expired' }
      : one,
  ),
})

/**
 * The mission the band shows: the running one closest to done, a daily before a weekly among equals; one over sessions
 * run together only once it has a moment.
 */
export const bandMissionOf = (missions: MissionsView | null): MissionView | null =>
  (missions?.quests ?? [])
    .filter(isBandWorthy)
    .reduce<MissionView | null>((best, one) => {
      if (best === null) return one
      const ahead = shareOf(one) - shareOf(best)
      return ahead > 0 || (ahead === 0 && one.cadence === 'daily' && best.cadence !== 'daily') ? one : best
    }, null)

/** The band's bar for a mission: a few cells of the band's own glyphs. */
const chipBar = 5
/** The fewest cells of a cut title worth showing, its space and ellipsis included. */
const minTitle = 12

/**
 * What row 2 of the band says about the missions in `room` cells: the running mission closest to done, its title, a
 * short bar and its count, giving way in steps (the title cut, then gone, then the bar); with none running, how many
 * are done. Null when nothing fits, or there is nothing to say.
 */
export const missionChip = (shownAt: MissionsView | null, room: number, now: number): Row | null => {
  if (shownAt === null || !shownAt.isKnown || room <= 0) return null
  const missions = missionsAt(shownAt, now)
  const shown = bandMissionOf(missions)
  if (shown === null) {
    const done = missions.quests.filter((one) => one.status === 'completed').length
    if (done === 0) return null
    const check: Run = { text: '✔', color: 'success' }
    const tries: Array<Row> = [
      [check, dim(` ${done} ${done === 1 ? 'mission' : 'missions'} done`)],
      [check, dim(` ${done} done`)],
    ]
    return tries.find((row) => cellsOfRow(row) <= room) ?? null
  }
  const color = cadenceColor(missions, shown.cadence)
  const mark: Run = { text: '◎', color, bold: true }
  const count: Run = { text: ` ${counted(shown.progress)}/${counted(shown.goal)}`, bold: true }
  const bar = [blank(1), ...meter(shareOf(shown), chipBar, color)]
  const title: Run = { text: ` ${shown.title}` }
  const full: Row = [mark, title, ...bar, count]
  if (cellsOfRow(full) <= room) return full
  // The title cut to what is left, if enough of it stays to read.
  const titleRoom = room - cellsOfRow([mark, ...bar, count])
  if (titleRoom >= minTitle) return [mark, ...clip([title], titleRoom), ...bar, count]
  const tries: Array<Row> = [
    [mark, ...bar, count],
    [mark, count],
  ]
  return tries.find((row) => cellsOfRow(row) <= room) ?? null
}

/** The cells left on a row of `columns` after pieces of these widths, `gap` cells between each and the next. */
export const roomBeside = (columns: number, widths: ReadonlyArray<number>, gap: number): number =>
  columns - widths.reduce((sum, width) => sum + width + gap, 0)

/** How long a window has left, in the largest two units: `2d 5h left`, `5h 20m left`, `20m left`. */
export const timeLeft = (expiresAt: number | null, now: number): string | null => {
  if (expiresAt === null) return null
  const minutes = Math.floor((expiresAt - now) / 60_000)
  if (minutes <= 0) return 'ending now'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h left`
  if (hours > 0) return `${hours}h ${minutes % 60}m left`
  return `${minutes}m left`
}

// The Missions tab.

/** What the pane offers beside a mission: pick it, give it up, nothing (the log is full), or no button at all. */
export type MissionAction = 'accept' | 'abandon' | 'full' | null

/** One mission in the tab: its head (beside its buttons), then under it its bar and count, and its rewards. */
export type MissionEntry = { mission: MissionView; head: Row; meter: Row; rewards: Row; action: MissionAction }

/** A run of missions under a small label, or a line saying why there are none. */
export type MissionGroup = { key: string; label: Row | null; entries: ReadonlyArray<MissionEntry>; empty: Row | null }

/** Today's dailies, or the week's weeklies, under a titled rule. */
export type MissionSection = { key: string; title: Row; groups: ReadonlyArray<MissionGroup> }

export type MissionsLayout = { intro: Row; note: Row | null; width: number; sections: ReadonlyArray<MissionSection> }

/** Cells a mission's details are set in from the tab's edge: under its head, which is set in 2. */
export const detailIndent = 4
/** The widest the tab lays its rows out, so a bar never stretches across a wide pane. */
const maxWidth = 64
const maxBar = 24
/**
 * Cells kept beside a head for what its action draws, the row's gap of 2 included: `[ Accept ]`, `[ Abandon ]`, or
 * the dim `log full`.
 */
const buttonRoom: Record<Exclude<MissionAction, null>, number> = { accept: 12, abandon: 13, full: 10 }

const glyphs: Record<MissionView['status'], string> = { active: '◎', completed: '✔', offered: '○', expired: '✕' }

const headOf = (missions: MissionsView, mission: MissionView, room: number): Row => {
  const color = cadenceColor(missions, mission.cadence)
  const glyphColor: Record<MissionView['status'], Run> = {
    active: { text: glyphs.active, color, bold: true },
    completed: { text: glyphs.completed, color: 'success', bold: true },
    offered: { text: glyphs.offered, color: 'inactive' },
    expired: { text: glyphs.expired, dim: true },
  }
  const title: Run =
    mission.status === 'expired' ? dim(` ${mission.title}`) : { text: ` ${mission.title}`, bold: true }
  return clip([glyphColor[mission.status], title], room)
}

const meterOf = (missions: MissionsView, mission: MissionView, width: number): Row => {
  const counts = countOf(mission)
  const states: Record<MissionView['status'], { count: Row; color: string }> = {
    active: { count: [{ text: counts, bold: true }], color: cadenceColor(missions, mission.cadence) },
    completed: { count: [{ text: '✔ done', color: 'success', bold: true }], color: 'success' },
    offered: { count: [dim(counts)], color: 'inactive' },
    expired: { count: [dim(`${counts} · ended`)], color: 'inactive' },
  }
  const { count, color } = states[mission.status]
  const share = mission.status === 'completed' ? 1 : shareOf(mission)
  const bar = Math.max(4, Math.min(maxBar, width - cellsOfRow(count) - 2))
  return clip([...meter(share, bar, color), blank(2), ...count], width)
}

/**
 * What a mission grants, as `Reward  +50 XP · +30 gold · +10% XP for 1h · rare drop`, in the band's colors and the
 * drop's rarity.
 */
export const rewardRuns = (rewards: MissionRewards): Array<Run> => {
  const { boost } = rewards
  const parts: Array<Array<Run>> = [
    ...(rewards.xp > 0 ? [[{ text: `+${counted(rewards.xp)} XP`, color: 'success' }]] : []),
    ...(rewards.gold > 0 ? [[{ text: `◈ +${counted(rewards.gold)} gold`, color: 'suggestion' }]] : []),
    ...(boost === undefined ? [] : [[{ text: boostText(boost), color: 'success' }]]),
    ...(rewards.loot === null ? [] : [[{ text: `◆ ${rewards.loot} drop`, color: rarityColors[rewards.loot] }]]),
  ]
  return parts.flatMap((part, i) => (i === 0 ? part : [dim(' · '), ...part]))
}

const rewardsRow = (rewards: MissionRewards, width: number): Row => {
  const runs = rewardRuns(rewards)
  if (runs.length === 0) return [dim('No reward listed')]
  return fitting([[dim('Reward  '), ...runs], runs], width)
}

const entryOf = (missions: MissionsView, mission: MissionView, action: MissionAction, width: number): MissionEntry => {
  const inner = width - detailIndent
  const headRoom = width - 2 - (action === null ? 0 : buttonRoom[action])
  return {
    mission,
    head: headOf(missions, mission, headRoom),
    meter: meterOf(missions, mission, inner),
    rewards: rewardsRow(mission.rewards, inner),
    action,
  }
}

/** A section's title over a rule to its edge, and what it says on the right, when there is room for it. */
export const sectionTitle = (title: string, right: string, width: number): Row => {
  const rule = width - cellsOf(title) - 2
  const withRight = rule - cellsOf(right) - 1
  if (right !== '' && withRight >= 3)
    return [{ text: title, bold: true, color: 'claude' }, dim(` ${'─'.repeat(withRight)} `), dim(right)]
  return [{ text: title, bold: true, color: 'claude' }, dim(` ${'─'.repeat(Math.max(0, rule + 1))}`)]
}

const hint = (text: string, width: number): Row => clip([dim(text)], width)

const label = (text: string, more: string, width: number): Row =>
  fitting([[{ text, bold: true }, dim(more === '' ? '' : `  ${more}`)], [{ text, bold: true }]], width)

/** The first of a set's windows that names its end. */
const endOf = (quests: ReadonlyArray<MissionView>): number | null =>
  quests.find((one) => one.expiresAt !== null)?.expiresAt ?? null

const join = (...parts: ReadonlyArray<string | null>): string =>
  parts.filter((part) => part !== null && part !== '').join(' · ')

/**
 * The tab for a pane `columns` wide at clock `now`: today's dailies, then the week's weeklies (running, done, on
 * offer, ended), each with its bar, count and rewards. The pane's buttons go beside the heads, as `action` says.
 */
export const missionsLayout = (shownAt: MissionsView, columns: number, now: number): MissionsLayout => {
  const missions = missionsAt(shownAt, now)
  const width = Math.max(20, Math.min(columns, maxWidth))
  const room = Math.max(20, columns)
  const picks = missions.weeklyActive
  const intro = fitting(
    [
      [{ text: 'Your missions', bold: true }, dim(`  dailies run on their own · pick ${picksText(picks)}`)],
      [{ text: 'Your missions', bold: true }, dim(`  pick ${picksText(picks)}`)],
      [{ text: 'Your missions', bold: true }],
    ],
    room,
  )
  if (!missions.isKnown) {
    const note = fitting(
      [
        [{ text: '◇ ', color: 'warning' }, dim('The server predates missions: restart it.')],
        [{ text: '◇ ', color: 'warning' }, dim('Restart the server.')],
      ],
      room,
    )
    return { intro, note, width, sections: [] }
  }

  const dailies = missions.quests.filter((one) => one.cadence === 'daily')
  const doneToday = dailies.filter((one) => one.status === 'completed').length
  const today: MissionSection = {
    key: 'daily',
    title: sectionTitle(
      'Today',
      join(dailies.length === 0 ? null : `${doneToday} of ${dailies.length} done`, timeLeft(endOf(dailies), now)),
      width,
    ),
    groups: [
      {
        key: 'daily',
        label: null,
        entries: dailies.map((one) => entryOf(missions, one, null, width)),
        empty: dailies.length === 0 ? hint('No dailies today: the quest packs offer none.', width - 2) : null,
      },
    ],
  }

  const weeklies = missions.quests.filter((one) => one.cadence === 'weekly')
  const of = (status: MissionView['status']) => weeklies.filter((one) => one.status === status)
  const running = of('active')
  const offered = of('offered')
  const isFull = picks !== null && running.length >= picks
  const left = picks === null ? null : Math.max(0, picks - running.length)
  const groups: Array<MissionGroup> = [
    {
      key: 'running',
      label: label('Running', picks === null ? `${running.length}` : `${running.length} of ${picks}`, width - 2),
      entries: running.map((one) => entryOf(missions, one, 'abandon', width)),
      empty:
        running.length === 0
          ? hint(offered.length === 0 ? 'None this week.' : 'Pick one below: it runs until the week ends.', width - 2)
          : null,
    },
    ...(of('completed').length === 0
      ? []
      : [
          {
            key: 'completed',
            label: label('Done', '', width - 2),
            entries: of('completed').map((one) => entryOf(missions, one, null, width)),
            empty: null,
          },
        ]),
    {
      key: 'offered',
      label: label(
        'On offer',
        isFull ? `${running.length} running, the most at once` : left === null ? '' : `pick ${left} more`,
        width - 2,
      ),
      entries: offered.map((one) => entryOf(missions, one, isFull ? 'full' : 'accept', width)),
      empty: offered.length === 0 ? hint('Nothing left on offer this week.', width - 2) : null,
    },
    ...(of('expired').length === 0
      ? []
      : [
          {
            key: 'expired',
            label: label('Ended', 'its week is over', width - 2),
            entries: of('expired').map((one) => entryOf(missions, one, null, width)),
            empty: null,
          },
        ]),
  ]
  const week: MissionSection = {
    key: 'weekly',
    title: sectionTitle('This week', timeLeft(endOf(weeklies), now) ?? '', width),
    groups,
  }
  return { intro, note: null, width, sections: [today, week] }
}

const picksText = (picks: number | null): string => (picks === null ? 'weeklies to run' : `up to ${picks} weeklies`)
