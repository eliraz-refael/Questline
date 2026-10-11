// Caps, streaks and dailies count local days in the player's time zone. A day is a `YYYY-MM-DD` string; day
// arithmetic runs on UTC dates, where every day is 24 hours long.

const formats = new Map<string, Intl.DateTimeFormat>()

/** The local day an instant falls on in `timeZone`. */
export const localDay = (instant: string, timeZone: string): string => {
  let format = formats.get(timeZone)
  if (format === undefined) {
    // en-CA formats dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    formats.set(timeZone, format)
  }
  return format.format(new Date(instant))
}

const dayMs = 86_400_000

export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10)

/** The Monday that starts the week `day` is in. */
export const weekOf = (day: string): string => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -((weekday + 6) % 7))
}

/** Days, with fractions, from instant `from` to instant `to`; never negative. */
export const daysBetween = (from: string, to: string): number => Math.max(0, (Date.parse(to) - Date.parse(from)) / dayMs)

/** Whether instant `a` is later than instant `b`. Compares the instants, not the strings: offsets and precision vary. */
export const isLater = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b)

const clocks = new Map<string, Intl.DateTimeFormat>()

/** How far `timeZone`'s wall clock runs ahead of UTC at an instant, in ms (negative when behind). */
const offsetAt = (ms: number, timeZone: string): number => {
  let clock = clocks.get(timeZone)
  if (clock === undefined) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    clocks.set(timeZone, clock)
  }
  const parts = clock.formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((one) => one.type === type)?.value ?? 0)
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"))
  return wall - (ms - (((ms % 1000) + 1000) % 1000))
}

/**
 * The instant local day `day` begins in `timeZone`: its midnight, or the first moment after it where a clock change
 * skips midnight.
 */
export const startOfDay = (day: string, timeZone: string): string => {
  const midnight = Date.parse(`${day}T00:00:00Z`)
  // The offset at a first guess, then at the instant that guess lands on, which differs across a clock change.
  let at = midnight - offsetAt(midnight, timeZone)
  at = midnight - offsetAt(at, timeZone)
  // A skipped midnight lands the guess on the evening before: step forward to the day's first hour.
  while (localDay(new Date(at).toISOString(), timeZone) < day) at += 3_600_000
  return new Date(at).toISOString()
}
