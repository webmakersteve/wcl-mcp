/** Specialization id → class, in WCL's class naming (actors.sub_type). */
const SPEC_CLASS: Record<number, string> = {
  250: "DeathKnight", 251: "DeathKnight", 252: "DeathKnight",
  577: "DemonHunter", 581: "DemonHunter", 1480: "DemonHunter",
  102: "Druid", 103: "Druid", 104: "Druid", 105: "Druid",
  1467: "Evoker", 1468: "Evoker", 1473: "Evoker",
  253: "Hunter", 254: "Hunter", 255: "Hunter",
  62: "Mage", 63: "Mage", 64: "Mage",
  268: "Monk", 269: "Monk", 270: "Monk",
  65: "Paladin", 66: "Paladin", 70: "Paladin",
  256: "Priest", 257: "Priest", 258: "Priest",
  259: "Rogue", 260: "Rogue", 261: "Rogue",
  262: "Shaman", 263: "Shaman", 264: "Shaman",
  265: "Warlock", 266: "Warlock", 267: "Warlock",
  71: "Warrior", 72: "Warrior", 73: "Warrior",
};

export function classForSpec(specId: number): string | undefined {
  return SPEC_CLASS[specId];
}

/**
 * Game difficulty id → WCL difficulty id. Raids: LFR/Normal/Heroic/Mythic → 1/3/4/5;
 * dungeons: Normal/Heroic → 1/2, Mythic and Mythic+ → 10.
 */
const DIFFICULTY_TO_WCL: Record<number, number> = {
  1: 1, 2: 2, 8: 10, 23: 10, 14: 3, 15: 4, 16: 5, 17: 1, 7: 1,
};

export function wclDifficulty(gameDifficulty: number): number {
  return DIFFICULTY_TO_WCL[gameDifficulty] ?? gameDifficulty;
}
