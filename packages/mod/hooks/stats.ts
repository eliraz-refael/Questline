import type { BandLook, BandSlot, BandView, Loop, StatsView, Tier } from '../types'
import { goldRow, labelRun, levelRow } from './band'
import type { Row, Run } from './cells'
import { cellsOf, glyphsOf } from './cells'
import { barRow, rarityColors } from './frames'

// The pane's Stats tab, laid out as rows of styled runs that register.tsx draws: cards under a titled rule, a label on
// the left of each row and its number on the right, and bars in the band's own ▰▱. Every number is the server's; this
// file only lays them out, each row as wide as its card, so nothing wraps however narrow the pane.

/** One card of the tab: its title, drawn over a rule, and its rows. */
export type StatCard = { key: string; title: string; rows: ReadonlyArray<Row> }

/** The tab as it fits the pane: a line on top, then the cards in one column, or in two from `twoColumnsFrom` on. */
export type StatsLayout = {
  intro: Row
  /** Said when the server is older than the mod and counts less than the tab shows. */
  note: Row | null
  width: number
  gap: number
  columns: ReadonlyArray<ReadonlyArray<StatCard>>
}

/** The band styles the tab draws its XP bar, level and gold in, as the band does, and the loops' clocks. */
export type StatsLooks = { looks: Partial<Record<BandSlot, BandLook>>; loop: Loop | null }

/** Cells a card takes at most, so a number never drifts far from its label on a wide pane. */
const maxCard = 56
/** Columns between two cards side by side. */
const cardGap = 4
/** The pane width that takes two cards side by side, each at least 40 cells. */
export const twoColumnsFrom = 2 * 40 + cardGap
/** Cells a row is set in from its card's edge. */
const indent = 2

/** The quality scores in the rubric's order, as the tab names them, with what raises each. */
const dimensions: ReadonlyArray<{ id: string; label: string; tip: string }> = [
  { id: 'clarity', label: 'Clarity', tip: 'make the ask unambiguous' },
  { id: 'grammar', label: 'Grammar', tip: 'mind spelling and punctuation' },
  { id: 'specificity', label: 'Specificity', tip: 'name the files, errors, symbols' },
  { id: 'instructive', label: 'Instructive', tip: 'say what, where, and the limits' },
  { id: 'context', label: 'Context', tip: 'give the why behind the ask' },
  { id: 'doneCriteria', label: 'Done criteria', tip: 'say how to know it is done' },
  { id: 'focus', label: 'Focus', tip: 'one well-sized ask at a time' },
]

/** A grade's color, as loot's: the better the grade, the rarer it looks. */
const gradeTier = (grade: number): Tier =>
  grade >= 9 ? 'legendary' : grade >= 8 ? 'epic' : grade >= 6.5 ? 'rare' : grade >= 5 ? 'uncommon' : 'common'

/** A context fill's color: low is the habit the stats reward. */
const fillColor = (pct: number): string => (pct >= 75 ? 'error' : pct >= 50 ? 'warning' : 'success')

/** A whole number with its thousands grouped. */
const counted = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const graded = (value: number): string => value.toFixed(1)
const percent = (value: number): string => `${Math.round(value)}%`
const days = (value: number): string => `${counted(value)} ${value === 1 ? 'day' : 'days'}`

const cellsOfRow = (row: Row): number => row.reduce((sum, run) => sum + cellsOf(run.text), 0)
const blank = (cells: number): Run => ({ text: ' '.repeat(Math.max(0, cells)) })
const dim = (text: string): Run => ({ text, dim: true })

/** A row cut to `room` cells, an ellipsis where it was cut. */
const clip = (row: Row, room: number): Row => {
  if (cellsOfRow(row) <= room) return row
  const kept: Array<Run> = []
  let left = Math.max(0, room - 1)
  for (const run of row) {
    let text = ''
    for (const glyph of glyphsOf(run.text)) {
      if (cellsOf(glyph) > left) break
      text += glyph
      left -= cellsOf(glyph)
    }
    if (text !== '') kept.push({ ...run, text })
    if (text !== run.text) break
  }
  return room <= 0 ? [] : [...kept, { text: '…', dim: true }]
}

/** A label on the left and a value on the right edge of a row `width` wide; a label with no room is cut. */
const line = (label: Row, value: Row, width: number): Row => {
  const right = cellsOfRow(value)
  if (right === 0) return [blank(indent), ...clip(label, width - indent)]
  const left = clip(label, width - indent - right - 1)
  return [blank(indent), ...left, blank(width - indent - cellsOfRow(left) - right), ...value]
}

/** A dim line of its own, cut to the card. */
const hint = (text: string, width: number): Row => [blank(indent), ...clip([dim(text)], width - indent)]

/** The first of `tries` that fits `room` cells, else the last cut to it. */
const fitting = (tries: ReadonlyArray<Row>, room: number): Row =>
  tries.find((row) => cellsOfRow(row) <= room) ?? clip(tries[tries.length - 1] ?? [], room)

/** A bar of `cells` in the band's glyphs, `share` of it filled; any share above none shows at least one cell. */
const meter = (share: number, cells: number, color: string): Row => {
  const clamped = Math.max(0, Math.min(1, share))
  const filled = clamped === 0 ? 0 : Math.max(1, Math.min(cells, Math.round(clamped * cells)))
  return [
    ...(filled > 0 ? [{ text: '▰'.repeat(filled), color }] : []),
    ...(cells - filled > 0 ? [{ text: '▱'.repeat(cells - filled), dim: true }] : []),
  ]
}

type Meter = { label: Row; share: number; color: string; value: Row; mark?: Row }

/**
 * Rows of label, bar and value, the labels padded to the longest and the values to the right edge, then any mark
 * (two cells, kept for every row so the values line up). The bars take what is left, as the band's XP bar does.
 */
const meters = (rows: ReadonlyArray<Meter>, width: number): Array<Row> => {
  const labels = Math.max(0, ...rows.map((row) => cellsOfRow(row.label)))
  const values = Math.max(0, ...rows.map((row) => cellsOfRow(row.value)))
  const marks = rows.some((row) => row.mark !== undefined) ? 2 : 0
  // Past the indent, the value and the marks: a space before the bar and one after it.
  const room = width - indent - values - marks - 2
  const labelCells = Math.min(labels, Math.max(0, room - 4))
  const bar = Math.max(1, room - labelCells)
  return rows.map((row) => {
    const label = clip(row.label, labelCells)
    const value = cellsOfRow(row.value)
    const gap = width - indent - cellsOfRow(label) - bar - 1 - values - marks
    const mark = row.mark ?? []
    return [
      blank(indent),
      ...label,
      blank(gap),
      ...meter(row.share, bar, row.color),
      blank(1 + values - value),
      ...row.value,
      ...mark,
      ...(marks > 0 ? [blank(marks - cellsOfRow(mark))] : []),
    ]
  })
}

const gradeValue = (grade: number): Row => [{ text: graded(grade), color: rarityColors[gradeTier(grade)], bold: true }]

const progressCard = (stats: StatsView, view: BandView, width: number, worn: StatsLooks): StatCard => {
  const { looks, loop } = worn
  const inner = width - indent
  const barLook = looks.xpBar ?? null
  const label = labelRun(view, barLook)
  const toNext = Math.max(0, view.xp.forNextLevel - view.xp.intoLevel)
  return {
    key: 'progress',
    title: 'Progress',
    rows: [
      line(levelRow(view, looks.levelDisplay ?? null, loop), [], width),
      // The bar as the band draws it, in the style worn: the bar and its label fill the row.
      [blank(indent), ...barRow(view, inner, null, barLook, loop), label],
      line([{ text: 'Total XP' }], [{ text: counted(view.xp.total), bold: true }], width),
      line([dim('├ '), dim('reported')], [dim(counted(stats.xp.reported))], width),
      line([dim('└ '), dim('verified on GitHub')], [dim(counted(stats.xp.verified))], width),
      line([{ text: `To Lv ${view.level + 1}` }], [{ text: `${counted(toNext)} xp` }], width),
      line([{ text: 'Gold' }], goldRow(view, looks.goldDisplay ?? null, loop), width),
      line([{ text: 'Items owned' }], [{ text: counted(stats.items) }], width),
    ],
  }
}

const streakCard = (stats: StatsView, width: number): StatCard => {
  const { streak } = stats
  const best = streak.best === null ? [dim('—')] : streak.best === 0 ? [dim('none yet')] : [{ text: days(streak.best) }]
  return {
    key: 'streak',
    title: 'Streak',
    rows: [
      line(
        [{ text: '🔥 ' }, { text: 'Current' }],
        [streak.days === 0 ? dim('none yet') : { text: days(streak.days), bold: true, color: 'warning' }],
        width,
      ),
      line([{ text: 'Best' }], best, width),
      line([{ text: 'Rest days left this week' }], [{ text: counted(streak.restDaysLeftThisWeek) }], width),
      ...(streak.days === 0 ? [hint('Any work today starts one.', width)] : []),
    ],
  }
}

const promptsCard = (stats: StatsView, width: number): StatCard => {
  const { prompts } = stats
  const share = prompts.graded === 0 ? '' : ` · ${percent((prompts.regretted / prompts.graded) * 100)}`
  const grades: Array<Meter> = [
    {
      label: [{ text: 'Average grade' }],
      share: prompts.average / 10,
      color: rarityColors[gradeTier(prompts.average)],
      value: gradeValue(prompts.average),
    },
    ...(prompts.best === null
      ? []
      : [
          {
            label: [{ text: 'Best grade' }],
            share: prompts.best / 10,
            color: rarityColors[gradeTier(prompts.best)],
            value: gradeValue(prompts.best),
          },
        ]),
  ]
  return {
    key: 'prompts',
    title: 'Prompts',
    rows: [
      line([{ text: 'Graded' }], [{ text: counted(prompts.graded), bold: true }], width),
      line([{ text: 'Today' }], [{ text: counted(prompts.today) }], width),
      ...(prompts.graded === 0 ? [hint('Prompts you type are graded.', width)] : meters(grades, width)),
      line([{ text: 'Regretted' }], [{ text: counted(prompts.regretted) }, dim(share)], width),
    ],
  }
}

/** The profile's dimensions in the rubric's order, then any the mod doesn't know yet, by the server's name. */
const ordered = (profile: NonNullable<StatsView['profile']>) => {
  const known = dimensions.flatMap((one) => {
    const found = profile.find((entry) => entry.dimension === one.id)
    return found === undefined ? [] : [{ ...one, average: found.average }]
  })
  const others = profile
    .filter((entry) => !dimensions.some((one) => one.id === entry.dimension))
    .map((entry) => ({ id: entry.dimension, label: entry.dimension, tip: '', average: entry.average }))
  return [...known, ...others]
}

const profileCard = (stats: StatsView, width: number): StatCard => {
  const card = (rows: ReadonlyArray<Row>): StatCard => ({ key: 'profile', title: 'Prompting profile', rows })
  if (stats.profile === null) return card([hint('Needs a newer server: restart it.', width)])
  if (stats.prompts.graded === 0 || stats.profile.length === 0) {
    return card([hint('Fills in as your prompts are graded,', width), hint('one bar per quality score.', width)])
  }
  const shown = ordered(stats.profile)
  const top = Math.max(...shown.map((one) => one.average))
  const low = Math.min(...shown.map((one) => one.average))
  // The first at the top and the first at the bottom, and only when the scores differ at all.
  const strongest = top > low ? shown.find((one) => one.average === top) : undefined
  const weakest = top > low ? shown.find((one) => one.average === low) : undefined
  const rows = meters(
    shown.map((one): Meter => {
      const isStrongest = one === strongest
      const isWeakest = one === weakest
      return {
        label: [{ text: one.label, ...(isStrongest || isWeakest ? { bold: true } : {}) }],
        share: one.average / 10,
        color: rarityColors[gradeTier(one.average)],
        value: gradeValue(one.average),
        ...(isStrongest ? { mark: [{ text: ' ▲', color: 'success' }] } : {}),
        ...(isWeakest ? { mark: [{ text: ' ▼', color: 'warning' }] } : {}),
      }
    }),
    width,
  )
  const room = width - indent
  const advice =
    weakest === undefined || strongest === undefined
      ? []
      : [
          [
            blank(indent),
            ...fitting(
              [
                [{ text: '▲ ', color: 'success' }, dim(`Strongest: ${strongest.label.toLowerCase()}`)],
                [{ text: '▲ ', color: 'success' }, dim(strongest.label.toLowerCase())],
              ],
              room,
            ),
          ],
          [
            blank(indent),
            ...fitting(
              [
                [{ text: '▼ ', color: 'warning' }, dim(`Work on ${weakest.label.toLowerCase()}: ${weakest.tip}`)],
                [{ text: '▼ ', color: 'warning' }, dim(weakest.tip === '' ? weakest.label : weakest.tip)],
              ],
              room,
            ),
          ],
        ]
  return card([...rows, ...advice])
}

const contextCard = (stats: StatsView, width: number): StatCard => {
  const { context, compactions } = stats
  const isMeasured = context.lastSession > 0 || context.average > 0 || context.pct50 > 0
  const peak = (label: string, pct: number): Meter => ({
    label: [{ text: label }],
    share: pct / 100,
    color: fillColor(pct),
    value: [{ text: percent(pct), color: fillColor(pct), bold: true }],
  })
  const peaks = meters([peak('Last session', context.lastSession), peak('Average peak', context.average)], width)
  const crossed = (pct: number, sessions: number) =>
    line([dim('Sessions past '), { text: `${pct}%`, color: fillColor(pct) }], [{ text: counted(sessions) }], width)
  return {
    key: 'context',
    title: 'Context habits',
    rows: [
      ...(isMeasured ? peaks : [hint('Measured each turn, at its fullest.', width)]),
      crossed(50, context.pct50),
      crossed(75, context.pct75),
      crossed(100, context.pct100),
      line([{ text: 'Clears' }], [{ text: counted(stats.clears) }], width),
      line(
        [{ text: 'Compactions' }],
        [{ text: counted(compactions.manual) }, dim(' manual · '), { text: counted(compactions.auto) }, dim(' auto')],
        width,
      ),
    ],
  }
}

/** Commands the card lists, most used first. */
const topCommands = 5

const commandsCard = (stats: StatsView, width: number): StatCard => {
  const top = stats.commands.slice(0, topCommands)
  const most = top[0]?.uses ?? 0
  const rows =
    top.length === 0
      ? [hint('Slash commands you run count here.', width)]
      : meters(
          top.map((command) => ({
            // The player's own commands count under one name, never theirs.
            label: command.name === 'custom' ? [dim('your own')] : [{ text: command.name }],
            share: most === 0 ? 0 : command.uses / most,
            color: 'claude',
            value: [{ text: counted(command.uses) }],
          })),
          width,
        )
  return { key: 'commands', title: 'Top commands', rows }
}

/** The tab for a pane `columns` wide: the cards in reading order, or in two columns side by side on a wide pane. */
export const statsLayout = (stats: StatsView, view: BandView, columns: number, worn: StatsLooks): StatsLayout => {
  const isWide = columns >= twoColumnsFrom
  const width = isWide
    ? Math.min(maxCard, Math.floor((columns - cardGap) / 2))
    : Math.max(20, Math.min(columns, maxCard))
  const left = [progressCard(stats, view, width, worn), streakCard(stats, width), promptsCard(stats, width)]
  const right = [profileCard(stats, width), contextCard(stats, width), commandsCard(stats, width)]
  const room = Math.max(20, columns)
  const intro = fitting(
    [
      [{ text: 'Your stats', bold: true }, dim('  counted by the server from your play')],
      [{ text: 'Your stats', bold: true }, dim('  counted from your play')],
      [{ text: 'Your stats', bold: true }],
    ],
    room,
  )
  const isOlder = stats.profile === null || stats.prompts.best === null || stats.streak.best === null
  const note = isOlder
    ? fitting(
        [
          [{ text: '◇ ', color: 'warning' }, dim('The server predates the bests and the profile: restart it.')],
          [{ text: '◇ ', color: 'warning' }, dim('Restart the server to count it all.')],
        ],
        room,
      )
    : null
  // A pane too narrow for even the shortest row cuts it at the card's edge rather than wrap it.
  const fit = (cards: ReadonlyArray<StatCard>) =>
    cards.map((card) => ({ ...card, rows: card.rows.map((row) => clip(row, width)) }))
  return { intro, note, width, gap: cardGap, columns: isWide ? [fit(left), fit(right)] : [fit([...left, ...right])] }
}

/** A card's title over a rule to its edge. */
export const titleRow = (title: string, width: number): Row => [
  { text: title, bold: true, color: 'claude' },
  dim(` ${'─'.repeat(Math.max(0, width - cellsOf(title) - 1))}`),
]
