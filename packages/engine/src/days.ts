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
