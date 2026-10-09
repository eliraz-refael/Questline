import type { CharacterSlot, Context, PetSlot, Player, PlayerState, Slot, Snapshot } from "@questline/schema"
import { isLater, localDay } from "./days.ts"
import { levelOf, moodNow, titleFor, totalXp } from "./derive.ts"
import { streakAsOf } from "./streak.ts"

const characterSlots: ReadonlyArray<CharacterSlot> = ["levelUpEffect", "scene"]
const petSlots: ReadonlyArray<PetSlot> = ["head", "neck", "back", "hand", "aura"]

const slotsOf = <S extends Slot>(equipped: PlayerState["holdings"]["equipped"], slots: ReadonlyArray<S>) => {
  const picked: { [K in S]?: string } = {}
  for (const slot of slots) {
    const entryId = equipped[slot]
    if (entryId !== undefined) picked[slot] = entryId
  }
  return picked
}

export interface SnapshotMeta {
  readonly player: Player
  readonly serverId: string
  readonly streamEpoch: number
  readonly cursor: number
}

/** The Snapshot the mod draws: the state with everything derived worked out under the rules in force. */
export const project = (
  state: PlayerState,
  context: Pick<Context, "rules" | "questPacks" | "now">,
  meta: SnapshotMeta,
): Snapshot => {
  const { rules, now } = context
  const { progress, holdings } = state
  const level = levelOf(state, rules)
  const today = localDay(now, state.timezone)
  const streak = streakAsOf(progress.activeDays, today, rules.streak.restDaysPerWeek)
  const quests = context.questPacks.flatMap((pack) => pack.quests.map((quest) => ({ pack, quest })))
  return {
    serverId: meta.serverId,
    streamEpoch: meta.streamEpoch,
    player: meta.player,
    character: {
      playerId: meta.player.id,
      name: state.characterName,
      level: level.level,
      xp: {
        total: totalXp(state),
        verified: progress.xp.verified,
        reported: progress.xp.reported,
        intoLevel: level.intoLevel,
        forNextLevel: level.forNextLevel,
      },
      title: titleFor(rules, level.level),
      prestige: progress.prestige,
      gold: holdings.gold,
      shards: holdings.shards,
      streak: {
        days: streak.days,
        restDaysLeftThisWeek: streak.restDaysLeftThisWeek,
        lastDay: progress.activeDays[progress.activeDays.length - 1] ?? today,
      },
      equipped: slotsOf(holdings.equipped, characterSlots),
    },
    pet:
      holdings.pet === null
        ? null
        : {
            species: holdings.pet.species,
            name: holdings.pet.name,
            form: holdings.pet.form,
            mood: moodNow(holdings.pet, rules, now),
            equipped: slotsOf(holdings.equipped, petSlots),
          },
    inventory: holdings.inventory,
    quests: progress.quests.map((active) => {
      const found = quests.find(({ pack, quest }) => pack.id === active.packId && quest.id === active.questId)
      return {
        questId: active.questId,
        packId: active.packId,
        title: found?.quest.title ?? active.questId,
        status: "active",
        progress: active.progress,
        goal: found?.quest.goal.count ?? active.progress,
        expiresAt: active.expiresAt,
      }
    }),
    claims: progress.claims.map((claim) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      subject: `${claim.work.repo}#${claim.work.number}`,
      status: claim.status,
    })),
    shop: [],
    boosts: progress.boosts.filter((boost) => isLater(boost.endsAt, now)),
    pity: holdings.loot.pity,
    achievements: holdings.achievements,
    cursor: meta.cursor,
  }
}
