// The engine has no randomness of its own: every draw comes from a hash of the player's secret seed and a counter,
// so roll 412 always gives the same result and a client can't change one by retrying. cyrb128 turns the text into
// four 32-bit words that seed sfc32; both are small, portable and run the same in Node and a browser.

const cyrb128 = (text: string): readonly [number, number, number, number] => {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** Numbers in [0, 1), the same sequence every time for the same seed and label. */
export const draws = (seed: string, label: string): (() => number) => {
  let [a, b, c, d] = cyrb128(`${seed}:${label}`)
  return () => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * Ids for whatever one input creates: a ULID whose time is the log row's receipt time and whose random part is
 * drawn from the seed and the log seq, so a replay creates the same ids.
 */
export const ulids = (seed: string, logSeq: number, now: string): (() => string) => {
  const next = draws(seed, `ids:${logSeq}`)
  let time = ""
  for (let ms = Date.parse(now), i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = crockford[ms % 32] + time
  return () => {
    let random = ""
    for (let i = 0; i < 16; i++) random += crockford[Math.floor(next() * 32)]
    return time + random
  }
}
