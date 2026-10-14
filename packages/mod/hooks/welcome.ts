import type { RulesConfig, Snapshot } from '@pathofdev/schema'
import type { BandView, GradingView, PaneTab, SpeciesView, WelcomeStep, WelcomeView, Wizard } from '../types'
import type { Row, Run } from './cells'
import { blank, cellsOf, cellsOfRow, clip, dim } from './cells'
import { dimensions } from './stats'
import { sprite } from './view'

// The first-run welcome, a tab of the pane: a hello, the character's name, the egg's species and name, how grading
// works, and a last word on the band and the pane. The server keeps whether it is done and what was picked, and checks
// every name; this file reads the snapshot and the rules, and lays each step out as rows of styled runs that
// register.tsx draws, with its fields and buttons between them. Every number it says is the rules'.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const numberOr = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** What the grading step says, from the rules beside the session and the `minWords` option. */
export const gradingOf = (rules: Partial<RulesConfig>, minWords: number): GradingView => {
  const prompt: Partial<RulesConfig['prompt']> = rules.prompt ?? {}
  const loot: Partial<RulesConfig['loot']> = rules.loot ?? {}
  const weights: Record<string, unknown> = isRecord(prompt.weights) ? prompt.weights : {}
  const perDay = Array.isArray(prompt.perDay)
    ? prompt.perDay.flatMap((band) =>
        typeof band.pct === 'number' && (band.upTo === null || typeof band.upTo === 'number')
          ? [{ upTo: band.upTo, pct: band.pct }]
          : [],
      )
    : null
  return {
    minWords,
    maxXp: numberOr(prompt.maxXp),
    perDay: perDay === null || perDay.length === 0 ? null : perDay,
    // The scores that count toward XP; every one of them when the rules don't say.
    counted: dimensions
      .filter((one) => !isRecord(prompt.weights) || (numberOr(weights[one.id]) ?? 0) > 0)
      .map((one) => one.id),
    lootAtTen: numberOr(loot.promptChanceAtTen),
    greatAt: numberOr(loot.promptGreatAt),
    greatFactor: numberOr(loot.promptGreatRareFactor),
  }
}

/**
 * The welcome as the snapshot and the rules give it. A server older than the welcome lists no species in its rules:
 * `isKnown` is false, and the mod never offers it there. Its snapshot can't tell either way: it carries no `welcome`.
 */
export const welcomeViewOf = (snapshot: Snapshot, rules: Partial<RulesConfig>, minWords: number): WelcomeView => {
  const listed: ReadonlyArray<unknown> = Array.isArray(rules.pet?.species) ? rules.pet.species : []
  const species = listed.flatMap((one): Array<SpeciesView> =>
    isRecord(one) && typeof one['id'] === 'string' && typeof one['name'] === 'string'
      ? [{ id: one['id'], name: one['name'], about: typeof one['about'] === 'string' ? one['about'] : '' }]
      : [],
  )
  const welcome: unknown = snapshot.welcome
  const egg: unknown = snapshot.egg
  return {
    // Only a server whose rules list the species an egg can be runs the welcome.
    isKnown: species.length > 0,
    // Read as done unless the snapshot says otherwise, so a reply missing it never offers the welcome again.
    isDone: !isRecord(welcome) || welcome['done'] !== false,
    species,
    egg:
      isRecord(egg) && typeof egg['species'] === 'string' && typeof egg['name'] === 'string'
        ? { species: egg['species'], name: egg['name'] }
        : null,
    grading: gradingOf(rules, minWords),
  }
}

/** The steps in order, with the name the progress row gives each. */
export const welcomeSteps: ReadonlyArray<{ id: WelcomeStep; label: string }> = [
  { id: 'hello', label: 'Welcome' },
  { id: 'name', label: 'Name' },
  { id: 'pet', label: 'Pet' },
  { id: 'grading', label: 'Grading' },
  { id: 'ready', label: 'Ready' },
]

const indexOf = (step: WelcomeStep): number =>
  Math.max(
    0,
    welcomeSteps.findIndex((one) => one.id === step),
  )

/** The step after `step`, or the last one. */
export const stepAfter = (step: WelcomeStep): WelcomeStep =>
  welcomeSteps[Math.min(welcomeSteps.length - 1, indexOf(step) + 1)]?.id ?? 'ready'

/** The step before `step`, or the first one. */
export const stepBefore = (step: WelcomeStep): WelcomeStep =>
  welcomeSteps[Math.max(0, indexOf(step) - 1)]?.id ?? 'hello'

/**
 * Whether a close of the pane sets the welcome aside, as Skip does: the player's own close while it shows. A reload's
 * close, or the mod's own, is none of theirs.
 */
export const closeSetsAside = (origin: string, shown: PaneTab): boolean => origin === 'person' && shown === 'welcome'

/** A welcome no step has touched yet: its first step, with nothing typed or picked. */
export const freshWizard: Wizard = { step: 'hello', name: null, species: null, petName: null, error: null }

/** The first of `tries` that fits `room` cells, else the last cut to it. */
const fitting = (tries: ReadonlyArray<Row>, room: number): Row =>
  tries.find((row) => cellsOfRow(row) <= room) ?? clip(tries[tries.length - 1] ?? [], room)

/** The step shown as a filled chip, so it stands out of the row at a glance. */
const pill = (text: string): Run => ({ text: ` ${text} `, color: 'inverseText', background: 'claude', bold: true })

/**
 * The progress row: the steps done ticked in green, the one shown filled, the ones to come dim, and how far along on
 * the right. It gives way in steps, down to the step's name and its number alone, so it never wraps.
 */
export const stepperRow = (step: WelcomeStep, width: number): Row => {
  const at = indexOf(step)
  const count = welcomeSteps.length
  const label = welcomeSteps[at]?.label ?? ''
  const named = (link: string): Row =>
    welcomeSteps.flatMap((one, i): Array<Run> => {
      const chip: Run =
        i < at
          ? { text: `✔ ${one.label}`, color: 'success' }
          : i === at
            ? pill(`${i + 1} ${one.label}`)
            : { text: `${i + 1} ${one.label}`, dim: true }
      if (i === 0) return [chip]
      return [i <= at ? { text: link, color: 'success' } : { text: link, dim: true }, chip]
    })
  const dots: Row = welcomeSteps.flatMap((one, i): Array<Run> => {
    const chip: Run = i < at ? { text: '●', color: 'success' } : i === at ? pill(one.label) : { text: '○', dim: true }
    return i === 0 ? [chip] : [{ text: ' ' }, chip]
  })
  const along = `${at + 1} of ${count}`
  const right = (row: Row): Row => {
    const room = width - cellsOfRow(row) - cellsOf(along)
    return room >= 3 ? [...row, blank(room), dim(along)] : row
  }
  return fitting(
    [right(named(' ── ')), right(named(' ─ ')), named(' ─ '), right(dots), dots, [pill(label), dim(` ${along}`)]],
    width,
  )
}

/** One of the eggs to pick from, as a card. */
export type SpeciesCard = SpeciesView & { face: string; isPicked: boolean; hotkey: string }

/** One numbered point of the grading step: its heading, what it says, and any rows of its own. */
export type GradingPoint = { key: string; title: Row; text: Row; rows: ReadonlyArray<Row> }

/** What a step shows besides its words: a field, the eggs, the pet that has hatched, the points, the band, or none. */
export type WelcomePart =
  | { kind: 'none' }
  | { kind: 'name'; value: string }
  | { kind: 'egg'; cards: ReadonlyArray<SpeciesCard>; value: string; preview: Row }
  | { kind: 'hatched'; card: Row; note: Row }
  | { kind: 'points'; points: ReadonlyArray<GradingPoint> }
  /** The player's own band as it stands, in their looks, drawn above the step's words. */
  | { kind: 'band' }

/** A step laid out: the progress row, its title and words, its own part, and its buttons. */
export type WelcomeLayout = {
  width: number
  stepper: Row
  title: Row
  /** Paragraphs the pane wraps to its width. */
  paragraphs: ReadonlyArray<Row>
  part: WelcomePart
  /** The server's word on the last save, in place. */
  error: Row | null
  /** The buttons along the foot: back (none on the first step), the next step's, and the way out. */
  back: string | null
  next: string
  skip: string
  /** How to work the pane from the keyboard. */
  keys: Row
}

/** The widest the welcome lays its rows out, so its paragraphs read as a column, not a banner. */
const maxWidth = 76

/** A share of XP in words: `full XP`, `half`, `a tenth`, else the percent. */
const shareWord = (pct: number): string =>
  pct >= 100 ? 'full XP' : pct === 50 ? 'half' : pct === 25 ? 'a quarter' : pct === 10 ? 'a tenth' : `${pct}%`

/** Parts in a sentence: `a`, `a and b`, `a, b and c`. */
const listed = (parts: ReadonlyArray<string>): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`

/**
 * How a local day's graded prompts taper, in a sentence, from the rules' bands: `A day's graded prompts earn full XP
 * for the first 20, half for the next 20 and a tenth after that.` Null when the rules don't say.
 */
export const taperText = (bands: GradingView['perDay']): string | null => {
  if (bands === null || bands.length === 0) return null
  let from = 0
  const parts = bands.map((band, i) => {
    const share = shareWord(band.pct)
    const part =
      band.upTo === null
        ? i === 0
          ? `${share} for every one`
          : `${share} after that`
        : i === 0
          ? `${share} for the first ${band.upTo}`
          : `${share} for the next ${band.upTo - from}`
    from = band.upTo ?? from
    return part
  })
  // Past the last band a prompt earns nothing.
  const closed = bands[bands.length - 1]?.upTo !== null ? [...parts, 'nothing after that'] : parts
  return `A day's graded prompts earn ${listed(closed)}.`
}

/** What a grade earns, in a sentence, from the rules' most XP a prompt earns. */
export const xpText = (maxXp: number | null): string =>
  maxXp === null
    ? 'The better the grade, the more XP the prompt earns.'
    : // As the engine rounds a grant: to the thousandth.
      `A 10 earns ${maxXp} XP and a 7 earns ${Math.round(maxXp * 700) / 1000}, before your sigil and boosts.`

/** The loot a grade rolls for, in a sentence, from the rules' chance at a 10 and the great grade's lift. */
export const lootText = (grading: Pick<GradingView, 'lootAtTen' | 'greatAt' | 'greatFactor'>): string => {
  const { lootAtTen, greatAt, greatFactor } = grading
  const chance =
    lootAtTen === null
      ? 'It also rolls for loot, likelier the better the grade'
      : `It also rolls for loot: a ${Math.round(lootAtTen * 100)}% chance at a 10, less as the grade falls`
  const lift =
    greatAt === null || greatFactor === null || greatFactor <= 1
      ? ''
      : `, and from a ${greatAt} the odds of a rare, epic or legendary drop ${
          greatFactor === 2 ? 'double' : greatFactor === 3 ? 'triple' : `rise ×${greatFactor}`
        }`
  return `${chance}${lift}.`
}

const text = (words: string): Row => [{ text: words }]

/** A numbered heading. */
const heading = (n: number, words: string): Row => [
  { text: `${n}  `, color: 'claude', bold: true },
  { text: words, bold: true },
]

/** The quality scores that count, each with what raises it, the labels lined up. */
const scoreRows = (counted: ReadonlyArray<string>, width: number): Array<Row> => {
  const shown = dimensions.filter((one) => counted.includes(one.id))
  const labels = Math.max(0, ...shown.map((one) => cellsOf(one.label)))
  return shown.map((one) =>
    clip(
      [blank(3), { text: one.label, color: 'suggestion' }, blank(labels - cellsOf(one.label) + 2), dim(one.tip)],
      width,
    ),
  )
}

/** Where the game server is, in the player's words: this machine, or the online server's origin. */
const serverWhere = (online: string | undefined): string =>
  online === undefined ? 'here on your machine' : `at ${online}`

/**
 * The grading step's points: who grades, what leaves (and to which server: `online`, the online server's origin, when
 * the mod plays there), quality over volume, a good prompt, the rewards, no penalty.
 */
export const gradingPoints = (grading: GradingView, width: number, online?: string): Array<GradingPoint> => [
  {
    key: 'who',
    title: heading(1, 'Haiku grades each prompt you type'),
    text: text(
      `Once you send a prompt of ${grading.minWords} words or more, Haiku grades it on your own Claude account, so ` +
        "you never wait for it. Slash commands, and prompts you didn't type, go ungraded.",
    ),
    rows: [],
  },
  {
    key: 'private',
    title: heading(2, 'Only the scores reach the game'),
    text: text(
      `Haiku reads the prompt, as Claude does. The game server, ${serverWhere(online)}, gets its scores and a ` +
        "word count: never the prompt, and never Haiku's note.",
    ),
    rows: [],
  },
  {
    key: 'quality',
    title: heading(3, 'Quality, not volume'),
    text: text(
      `${taperText(grading.perDay) ?? 'XP tapers off over a day.'} A few clear prompts beat a flood of quick ones.`,
    ),
    rows: [],
  },
  {
    key: 'good',
    title: heading(4, 'What makes a well-graded prompt'),
    text: text(
      'Each score is out of 10, against what the prompt needs: a short follow-up loses nothing for context it ' +
        "doesn't need.",
    ),
    rows: scoreRows(grading.counted, width),
  },
  {
    key: 'rewards',
    title: heading(5, 'From grade to XP and loot'),
    text: text(`The scores make the prompt's grade, from 0 to 10. ${xpText(grading.maxXp)} ${lootText(grading)}`),
    rows: [],
  },
  {
    key: 'kind',
    title: heading(6, 'A weak prompt is never punished'),
    text: text(
      'A low grade only earns less. Nothing is ever taken away, it still counts toward your streak, and your pet ' +
        'never minds.',
    ),
    rows: [],
  },
]

/** A species' name inside a sentence: `the owl`. */
export const speciesWord = (species: ReadonlyArray<SpeciesView>, id: string): string =>
  (species.find((one) => one.id === id)?.name ?? id).toLowerCase()

/** Everything a step reads beside the welcome itself. */
export type WelcomeInput = {
  view: WelcomeView
  band: BandView
  wizard: Wizard
  columns: number
  /** The pane holds the keyboard. */
  isFocused: boolean
  /** The surface draws a text field: the mobile app doesn't yet. */
  hasInput: boolean
  /** The online server's origin, when the mod plays there rather than on this machine. */
  online?: string
}

/** How to work the pane; `eggs` is how many egg cards carry a hotkey, on the pet step. */
const keysHint = (isFocused: boolean, step: WelcomeStep, eggs: number): Row => {
  const picks = step !== 'pet' || eggs === 0 ? '' : eggs === 1 ? ' · 1 picks the egg' : ` · 1-${eggs} picks an egg`
  return isFocused
    ? [dim(`tab moves · enter presses${picks} · esc hands the keys back`)]
    : [dim('ctrl+x tab, or a click, hands this pane the keys')]
}

/** The step the wizard is on, laid out for `columns`. */
export const welcomeLayout = (input: WelcomeInput): WelcomeLayout => {
  const { view, band, wizard, hasInput } = input
  const width = Math.max(20, Math.min(input.columns, maxWidth))
  const step = wizard.step
  const base = {
    width,
    stepper: stepperRow(step, width),
    error: wizard.error === null ? null : [{ text: wizard.error, color: 'error' }],
    back: step === 'hello' ? null : 'Back',
    skip: view.isDone ? 'Close' : 'Skip the welcome',
    keys: keysHint(input.isFocused, step, view.isKnown && band.pet === null ? Math.min(9, view.species.length) : 0),
  }
  switch (step) {
    case 'hello':
      return {
        ...base,
        title: [
          { text: '⚔  ', color: 'claude' },
          { text: 'Welcome to Path of Dev', bold: true },
        ],
        paragraphs: [
          text(
            'An RPG around your work with Claude Code. Clear prompts and real work earn XP, levels and loot; a pet ' +
              'keeps you company on the band above your prompt, and missions point you at better habits.',
          ),
          text(
            input.online === undefined
              ? 'It all plays on this machine: no account, no sign-in, and your save is yours.'
              : `You play on the online server at ${input.online}, signed in with GitHub (/pathofdev logout signs ` +
                  'you out). It never hears a repo by name, only keys made on this machine.',
          ),
          text("Four short steps: name your character, pick your egg, see how grading works, and you're in."),
        ],
        part: { kind: 'none' },
        next: "Let's begin",
      }
    case 'name':
      return {
        ...base,
        title: [
          { text: '✎  ', color: 'claude' },
          { text: 'Name your character', bold: true },
        ],
        paragraphs: [
          text('It heads this pane, beside your level and title. Rename it here any time; nothing else changes.'),
          ...(hasInput ? [] : [[dim('Naming takes a keyboard: open the welcome in the terminal or the desktop app.')]]),
        ],
        part: hasInput ? { kind: 'name', value: wizard.name ?? band.name } : { kind: 'none' },
        next: 'Next',
      }
    case 'pet': {
      const title: Row = [
        { text: '🥚 ', color: 'claude' },
        { text: 'Pick your egg', bold: true },
      ]
      if (band.pet !== null) {
        const pet = band.pet
        return {
          ...base,
          title: [
            { text: '♥  ', color: 'error' },
            { text: 'Your pet', bold: true },
          ],
          paragraphs: [text('It keeps you company on the band. It never gets sick, never leaves, and never nags.')],
          part: {
            kind: 'hatched',
            card: [
              { text: `${sprite(pet)}  `, color: 'claude', bold: true },
              { text: pet.name, bold: true },
              dim(` the ${speciesWord(view.species, pet.species)}`),
            ],
            note: [dim('It has hatched, and a pet keeps its species and name for good.')],
          },
          next: 'Next',
        }
      }
      const picked = wizard.species ?? view.egg?.species ?? view.species[0]?.id ?? ''
      const name = wizard.petName ?? view.egg?.name ?? ''
      const cards = view.species.map((one, i): SpeciesCard => ({
        ...one,
        face: sprite({ species: one.id, name: one.name, form: 0, mood: 100 }),
        isPicked: one.id === picked,
        hotkey: i < 9 ? String(i + 1) : '',
      }))
      const shownName = name.trim() === '' ? 'Your egg' : name.trim()
      const ready = band.level >= 1
      const preview: Row = [
        { text: '🥚 ' },
        { text: shownName, bold: true },
        dim(` the ${speciesWord(view.species, picked)} · `),
        ready ? { text: 'ready to hatch from the band', color: 'success' } : dim('hatches at Lv 1, on the band'),
      ]
      return {
        ...base,
        title,
        paragraphs: [
          text(
            'It hatches at level 1, usually in your first session, and keeps you company on the band. It never gets ' +
              'sick, never leaves, and never nags. Pick the species and its name now; they stay once it hatches.',
          ),
          ...(hasInput ? [] : [[dim('Naming takes a keyboard: the egg keeps its name until you name it there.')]]),
        ],
        part: { kind: 'egg', cards, value: name, preview: clip(preview, width) },
        next: 'Next',
      }
    }
    case 'grading':
      return {
        ...base,
        title: [
          { text: '✦  ', color: 'claude' },
          { text: 'How grading works', bold: true },
        ],
        paragraphs: [],
        part: { kind: 'points', points: gradingPoints(view.grading, width, input.online) },
        next: 'Next',
      }
    case 'ready': {
      const pet = band.pet
      const petWords = pet !== null ? pet.name : `your egg${view.egg === null ? '' : `, ${view.egg.name},`}`
      return {
        ...base,
        title: [{ text: '✔  ', color: 'success' }, { text: `You're all set, ${band.name}`, bold: true }],
        paragraphs: [
          text(
            `It sits above the prompt: your XP bar, level and title, gold, ${petWords} and the mission closest to ` +
              'done. Each reward lands there as it comes.',
          ),
          text(
            'This pane is /pathofdev: Inventory for your looks and your pet, Shop for the daily shelf, Stats for ' +
              'your prompting profile, and Missions for the dailies and weeklies.',
          ),
          text(
            `${pet === null ? 'Once it hatches, /pet or a click on it' : '/pet, or a click on it,'} gives it a pat. ` +
              'Come back to this guide any time: its tab, last in the bar, or /pathofdev welcome.',
          ),
        ],
        part: { kind: 'band' },
        next: 'Start playing',
      }
    }
  }
}
