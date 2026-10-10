import { Schema } from "effect"
import { Count, Name, Rarity, Slot, Ulid } from "./primitives.ts"

// Commands are player choices, answered synchronously. Like events they carry a ULID and are idempotent;
// unlike events they can be refused.

const command = <Type extends string, Data extends Schema.Struct.Fields>(type: Type, data: Data) =>
  Schema.Struct({ id: Ulid, type: Schema.Literal(type), data: Schema.Struct(data) })

export const PetHatch = command("pet.hatch", { species: Schema.String, name: Name })
export const PetRename = command("pet.rename", { name: Name })
export const PetPet = command("pet.pet", {})
export const PetFeed = command("pet.feed", { entryId: Ulid })
export const ItemEquip = command("item.equip", { entryId: Ulid, slot: Slot })
export const ItemUnequip = command("item.unequip", { slot: Slot })
export const ItemDye = command("item.dye", { entryId: Ulid, dye: Schema.String })
/** A duplicate becomes shards of its rarity. */
export const ItemSalvage = command("item.salvage", { entryId: Ulid })
/** A duplicate, plus gold, becomes a random item of the same rarity. */
export const ItemReroll = command("item.reroll", { entryId: Ulid })
export const ShopBuy = command("shop.buy", { offerId: Schema.String })
export const ShardsCraft = command("shards.craft", { rarity: Rarity, itemId: Schema.String })
export const QuestAccept = command("quest.accept", { questId: Schema.String })
export const QuestAbandon = command("quest.abandon", { questId: Schema.String })
export const CharacterRename = command("character.rename", { name: Name })
export const CharacterPrestige = command("character.prestige", {})

// Dev commands, for trying the game out in a sandbox: a local server in dev mode runs them, with its own home, and
// every other server refuses them. What they make is marked `dev` (an entry's source, an XP or gold reason).

/** One item of the catalogue, by id. */
export const DevGrantItem = command("dev.grantItem", { itemId: Schema.String })
/** Every band style of the catalogue not owned yet. */
export const DevGrantStyles = command("dev.grantStyles", {})
/** XP, crossing level-ups as play would. */
export const DevGrantXp = command("dev.grantXp", { amount: Count.pipe(Schema.check(Schema.isGreaterThan(0))) })
export const DevSetGold = command("dev.setGold", { gold: Count })

export const DevCommand = Schema.Union([DevGrantItem, DevGrantStyles, DevGrantXp, DevSetGold])
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
  DevGrantItem,
  DevGrantStyles,
  DevGrantXp,
  DevSetGold,
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
