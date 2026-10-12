import { Schema } from "effect"
import { Count, Name, Rarity, Slot, TypedName, Ulid } from "./primitives.ts"

// Commands are player choices, answered synchronously. Like events they carry a ULID and are idempotent;
// unlike events they can be refused.

const command = <Type extends string, Data extends Schema.Struct.Fields>(type: Type, data: Data) =>
  Schema.Struct({ id: Ulid, type: Schema.Literal(type), data: Schema.Struct(data) })

export const PetHatch = command("pet.hatch", { species: Schema.String, name: Name })
export const PetRename = command("pet.rename", { name: Name })
/** A pat: it lifts the pet's mood a little, a few times an hour; past that it is never refused, and adds nothing. */
export const PetPet = command("pet.pet", {})
/** Food the pet eats: it lifts its mood and starts the food's XP boost. */
export const PetFeed = command("pet.feed", { entryId: Ulid })
export const ItemEquip = command("item.equip", { entryId: Ulid, slot: Slot })
export const ItemUnequip = command("item.unequip", { slot: Slot })
export const ItemDye = command("item.dye", { entryId: Ulid, dye: Schema.String })
/** A duplicate becomes shards of its rarity. */
export const ItemSalvage = command("item.salvage", { entryId: Ulid })
/** A duplicate, plus gold, becomes a random other item of the same rarity, never a sigil. */
export const ItemReroll = command("item.reroll", { entryId: Ulid })
/** One of today's offers, for its price in gold. */
export const ShopBuy = command("shop.buy", { offerId: Schema.String })
/** Shards of a rarity become a chosen item of that rarity, never a sigil. */
export const ShardsCraft = command("shards.craft", { rarity: Rarity, itemId: Schema.String })
export const QuestAccept = command("quest.accept", { questId: Schema.String })
export const QuestAbandon = command("quest.abandon", { questId: Schema.String })
/** The character's name, as the band and the pane show it. */
export const CharacterRename = command("character.rename", { name: TypedName })
export const CharacterPrestige = command("character.prestige", {})
/**
 * The egg picked in the welcome: a species of the rules' and a name, which the egg hatches as. Only before it hatches:
 * after that the pet keeps both.
 */
export const EggChoose = command("egg.choose", { species: Schema.String, name: TypedName })
/** The first-run welcome finished or skipped, so it never shows again on its own. Done once; again changes nothing. */
export const WelcomeDone = command("welcome.done", {})

// Dev commands, for trying the game out in a sandbox: a local server in dev mode runs them, with its own home, and
// every other server refuses them. What they make is marked `dev` (an entry's source, an XP or gold reason).

/** One item of the catalogue, by id. */
export const DevGrantItem = command("dev.grantItem", { itemId: Schema.String })
/** Every band style of the catalogue not owned yet. */
export const DevGrantStyles = command("dev.grantStyles", {})
/** XP, crossing level-ups as play would. */
export const DevGrantXp = command("dev.grantXp", { amount: Count.pipe(Schema.check(Schema.isGreaterThan(0))) })
export const DevSetGold = command("dev.setGold", { gold: Count })
/** A running mission finished at once, its rewards granted as play would, marked dev. */
export const DevCompleteQuest = command("dev.completeQuest", { questId: Schema.String })
/** This window's missions rolled again, as if the day and the week had just begun. */
export const DevRollQuests = command("dev.rollQuests", {})
/**
 * A stand-in session, open for a while, with one prompt graded 10 in it toward the running parallel missions: a good
 * prompt in the player's own session soon after makes a moment with it, so one terminal can try a parallel goal.
 */
export const DevFakeSession = command("dev.fakeSession", {})
/** Today's shop back in stock, as if the day had just begun. */
export const DevRestockShop = command("dev.restockShop", {})
/** The pet's mood set, to try a happy or a sleepy pet. */
export const DevSetMood = command("dev.setMood", {
  mood: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
})
/** Shards of every rarity set to `count`, to try crafting. */
export const DevSetShards = command("dev.setShards", { count: Count })

export const DevCommand = Schema.Union([
  DevGrantItem,
  DevGrantStyles,
  DevGrantXp,
  DevSetGold,
  DevCompleteQuest,
  DevRollQuests,
  DevFakeSession,
  DevRestockShop,
  DevSetMood,
  DevSetShards,
])
export type DevCommand = typeof DevCommand.Type

export const Command = Schema.Union([
  PetHatch,
  PetRename,
  PetPet,
  PetFeed,
  ItemEquip,
  ItemUnequip,
  ItemDye,
  ItemSalvage,
  ItemReroll,
  ShopBuy,
  ShardsCraft,
  QuestAccept,
  QuestAbandon,
  CharacterRename,
  CharacterPrestige,
  EggChoose,
  WelcomeDone,
  DevGrantItem,
  DevGrantStyles,
  DevGrantXp,
  DevSetGold,
  DevCompleteQuest,
  DevRollQuests,
  DevFakeSession,
  DevRestockShop,
  DevSetMood,
  DevSetShards,
])
export type Command = typeof Command.Type
export type CommandType = Command["type"]

export const RefusalCode = Schema.Literals([
  "not_allowed",
  "invalid",
  "not_owned",
  "insufficient_gold",
  "insufficient_shards",
  "sold_out",
  "taken",
])
export type RefusalCode = typeof RefusalCode.Type

export const CommandRefusal = Schema.Struct({ code: RefusalCode, message: Schema.String })
export interface CommandRefusal extends Schema.Schema.Type<typeof CommandRefusal> {}
