// Ids and keys the mod makes itself: ULIDs for events and sessions, and the HMAC subject keys. The secret behind
// the keys is made once per machine and never leaves it.

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A ULID: 10 characters of time, then 16 random ones. */
export const ulid = (now: number): string => {
  let time = ''
  for (let ms = now, i = 0; i < 10; i++, ms = Math.floor(ms / 32)) time = crockford[ms % 32] + time
  const random = crypto.getRandomValues(new Uint8Array(16))
  let tail = ''
  for (const byte of random) tail += crockford[byte % 32]
  return time + tail
}

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

const fromHex = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** 32 random bytes, in hex. */
export const newSecret = (): string => hex(crypto.getRandomValues(new Uint8Array(32)))

export const isSecret = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  return joined
}

/** SHA-256 reads its input in blocks of this many bytes; HMAC pads the key to one block. */
const block = 64

/**
 * HMAC-SHA256 of `message` under the machine's secret, in hex: the form every subject key takes. Written out from
 * SHA-256 (RFC 2104), since the mod's environment offers `crypto.subtle.digest` alone.
 */
export const hmac = async (secret: string, message: string): Promise<string> => {
  const key = new Uint8Array(block)
  key.set(fromHex(secret))
  const inner = key.map((byte) => byte ^ 0x36)
  const outer = key.map((byte) => byte ^ 0x5c)
  const innerHash = await sha256(concat(inner, new TextEncoder().encode(message)))
  return hex(await sha256(concat(outer, innerHash)))
}
