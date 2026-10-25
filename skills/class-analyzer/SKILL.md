---
name: class-analyzer
description: Evaluate how well a World of Warcraft player played their class and spec in a Warcraft Logs report or local combat log. Use whenever the wcl MCP tools are used to judge a player's performance, rotation, cooldown usage, uptime, or mistakes, or to compare players of the same spec. Maps every class and spec to its role, a short summary of how it plays, its SimulationCraft action priority list (APL), its Wowhead rotation and abilities guides, and (for pet classes) the pets whose actions count toward the player.
---

# Class analyzer

Use this skill to judge a player's play against what their spec is supposed to do. The analysis
data comes from the wcl MCP tools; the reference material lives on the web and is linked from
here instead of copied, because it changes every patch. Fetch the references for the player's
spec each time you need them rather than relying on memory, which is usually a patch or more
out of date.

## How to evaluate a player

1. **Identify the class and spec** from the report (`get_report_details`, or the `actors` and
   combatant info tables via `execute_readonly_query`). Find the matching section below.
2. **Load the references for that spec:**
   - **SimulationCraft APL.** The default action priority list is the most precise statement of
     the spec's priorities: which abilities to use, in what order, under which conditions, and
     how cooldowns line up. Fetch the raw `.simc` file linked in the spec's section. The APL
     syntax (`actions.<list>+=/<ability>,if=<condition>`, `call_action_list`,
     `run_action_list`, `variable`, the `buff.`/`debuff.`/`cooldown.`/`talent.` expressions) is
     documented at <https://github.com/simulationcraft/simc/wiki/ActionLists>. All APLs are
     listed at <https://github.com/simulationcraft/simc/tree/midnight/ActionPriorityLists/default>.
     SimulationCraft doesn't model healing, so healer specs have no default APL.
   - **Wowhead rotation and cooldowns guide.** Explains the priorities in plain language, how
     the spec is evaluated, common mistakes, and cooldown planning. This is the primary
     reference for healers.
   - **Wowhead abilities and talents guide.** Short explanations of what each ability is
     actually for, beyond the tooltip text. Use it to understand an ability before judging how
     the player used it.

   Fetch Wowhead pages with WebFetch. If a page comes back empty or incomplete, it needs
   JavaScript; use a headless browser if one is available.
3. **Compare the log to the references.** Useful measures, all queryable from the event
   tables:
   - Cast counts and casts per minute of core abilities and cooldowns versus the number of
     casts the fight length allows (cooldown usage efficiency).
   - Buff and debuff uptimes the guide calls essential (DoTs, maintenance buffs, defensive
     mitigation for tanks).
   - Whether major cooldowns are used together and at the times the APL and guide prescribe,
     and whether they are delayed or held through a fight.
   - Resource handling: overcapping or wasting the spec's resource.
   - Downtime (gaps between casts) and deaths, and what preceded each death.
   - Use `lookup_spells` to map spell IDs in the log to names before comparing them to the
     APL, which refers to abilities by snake_case name.
4. **Account for context.** Talents and hero talents change the priority list, so check the
   player's talents before calling something a mistake. Fight mechanics (movement, target
   switches, intermissions, adds) legitimately change the rotation; compare to other players
   of the same spec in the same fight when possible.
5. **Report specific findings** with timestamps, counts, and the reference that supports each
   one, not general advice.

## Pets and guardians

Some specs deal a large share of their damage (or mitigation) through pets, guardians, and
summoned units. Those specs have a **Pets** entry below. **Attribute pet and guardian actions
to the owning player unless the user says otherwise:** a player's damage, casts, and
contribution include everything their pets did. In the database, pets are separate rows in
`actors` with `pet_owner` pointing at the owner's `actor_id`, and in event queries
`source_owner_key` credits each pet event to its owner. Group by `source_owner_key`, not
`source_key`, when totalling a player's output. The pet lists below are the common ones; the
log's own `actors` table is authoritative for what a player actually summoned, and some pets
only appear with specific talents or hero talents.

## Death Knight

### Blood

- **Role:** Tank
- **How it plays:** A self-sustaining tank that mitigates through healing rather than avoidance.
  Heart Strike and Marrowrend generate Runic Power and keep Bone Shield up; Death Strike heals
  for a share of recent damage taken, so its timing after big hits matters more than raw cast
  count. Dancing Rune Weapon and Vampiric Blood are the main cooldowns.
- **Pets:** Ghoul (temporary, from Raise Dead), Dancing Rune Weapon (a rune weapon that copies
  the player's strikes), Rider of the Apocalypse horsemen (Mograine, Whitemane, Trollbane,
  Nazgrim) with that hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/deathknight_blood.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/death-knight/blood/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/death-knight/blood/abilities-talents-pve-tank>

### Frost

- **Role:** DPS (melee)
- **How it plays:** A Rune and Runic Power melee spec built around procs: Killing Machine
  empowers Obliterate and Rime empowers Howling Blast, while Frost Strike spends Runic Power.
  Damage is concentrated in Pillar of Frost windows, with Breath of Sindragosa or Frostwyrm's
  Fury depending on talents.
- **Pets:** Ghoul (temporary, from Raise Dead), Rider of the Apocalypse horsemen (Mograine,
  Whitemane, Trollbane, Nazgrim) with that hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/deathknight_frost.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/death-knight/frost/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/death-knight/frost/abilities-talents-pve-dps>

### Unholy

- **Role:** DPS (melee)
- **How it plays:** A disease and minion spec. The player applies diseases, builds and bursts
  Festering Wounds, and spends Runic Power on Death Coil or Epidemic, while a permanent ghoul
  and temporary undead summons deal a large share of the damage. Dark Transformation and Army of
  the Dead are the key cooldowns to line up.
- **Pets:** Ghoul (permanent pet, empowered by Dark Transformation), Army of the Dead ghouls,
  lesser ghouls, Rider of the Apocalypse horsemen (Mograine, Whitemane, Trollbane, Nazgrim)
  with that hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/deathknight_unholy.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/death-knight/unholy/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/death-knight/unholy/abilities-talents-pve-dps>

## Demon Hunter

### Havoc

- **Role:** DPS (melee)
- **How it plays:** A fast, mobile Fury spec. Builders and passive Fury generation fund Chaos
  Strike and Blade Dance, Eye Beam is the core cooldown that feeds Metamorphosis, Essence Break
  opens damage windows, and Vengeful Retreat is part of the damage rotation, not just mobility.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/demonhunter_havoc.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/demon-hunter/havoc/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/demon-hunter/havoc/abilities-talents-pve-dps>

### Vengeance

- **Role:** Tank
- **How it plays:** A self-healing tank that generates Soul Fragments and consumes them for
  healing. Demon Spikes provides active physical mitigation, Fiery Brand and Metamorphosis are
  the big defensives, and Sigils provide damage and crowd control.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/demonhunter_vengeance.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/demon-hunter/vengeance/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/demon-hunter/vengeance/abilities-talents-pve-tank>

### Devourer

- **Role:** DPS (ranged)
- **How it plays:** A mid-range Intellect caster that wields Void magic. The player gathers and
  consumes souls to fuel Void Metamorphosis, and spends in it with abilities such as Void Ray
  and Collapsing Star; managing soul collection and the metamorphosis window is the core of the
  spec.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/demonhunter_devourer.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/demon-hunter/devourer/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/demon-hunter/devourer/abilities-talents-pve-dps>

## Druid

### Balance

- **Role:** DPS (ranged)
- **How it plays:** An Astral Power caster. Moonfire and Sunfire (and Stellar Flare if talented)
  must be maintained, Wrath and Starfire build Astral Power and drive Eclipse, and Starsurge or
  Starfall spend it. Celestial Alignment or Incarnation is the main cooldown.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/druid_balance.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/druid/balance/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/druid/balance/abilities-talents-pve-dps>

### Feral

- **Role:** DPS (melee)
- **How it plays:** An Energy and combo point bleed spec. Rake, Rip, and Thrash need high
  uptime, Ferocious Bite spends excess combo points, and Tiger's Fury and Berserk (or
  Incarnation) amplify damage. Bleeds snapshot the buffs active when applied, so timing matters.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/druid_feral.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/druid/feral/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/druid/feral/abilities-talents-pve-dps>

### Guardian

- **Role:** Tank
- **How it plays:** A high-health bear tank. Mangle, Thrash, and Moonfire generate Rage, which
  is spent on Ironfur stacks for physical mitigation and Frenzied Regeneration for healing.
  Barkskin, Survival Instincts, and Incarnation or Berserk are the cooldowns.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/druid_guardian.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/druid/guardian/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/druid/guardian/abilities-talents-pve-tank>

### Restoration

- **Role:** Healer
- **How it plays:** A heal-over-time healer. Rejuvenation, Lifebloom, and Wild Growth keep heals
  rolling on the group ahead of damage, Swiftmend and Regrowth handle spikes, and Tranquility
  and Convoke the Spirits or Incarnation are the major cooldowns. Proactive HoT coverage matters
  more than reactive casting.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/druid/restoration/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/druid/restoration/abilities-talents-pve-healer>

## Evoker

### Augmentation

- **Role:** DPS (ranged, support)
- **How it plays:** A support DPS that amplifies allies. Ebon Might and Prescience buff the
  strongest damage dealers and Breath of Eons amplifies burst windows, so much of the spec's
  contribution is credited to the buffed allies rather than shown as its own damage. Judge it on
  buff uptime and target choice, not raw personal damage.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/evoker_augmentation.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/evoker/augmentation/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/evoker/augmentation/abilities-talents-pve-dps>

### Devastation

- **Role:** DPS (ranged)
- **How it plays:** A mid-range caster using Essence and empowered spells. Fire Breath and
  Eternity Surge are charged to a chosen rank, Disintegrate and Pyre spend Essence, and
  Dragonrage is the main burst cooldown.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/evoker_devastation.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/evoker/devastation/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/evoker/devastation/abilities-talents-pve-dps>

### Preservation

- **Role:** Healer
- **How it plays:** A mid-range healer built on empowered spells (Dream Breath, Spiritbloom),
  Echo to duplicate heals, and Reversion as a heal over time. Temporal Anomaly and Rewind or
  Dream Flight are group cooldowns.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/evoker/preservation/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/evoker/preservation/abilities-talents-pve-healer>

## Hunter

### Beast Mastery

- **Role:** DPS (ranged)
- **How it plays:** A ranged pet spec where most damage comes from the pet and summoned beasts.
  Barbed Shot keeps the pet's Frenzy up, Kill Command is the core pet ability, Cobra Shot fills,
  and Bestial Wrath is the main cooldown. The hunter can cast while moving, so downtime should
  be low.
- **Pets:** The main hunter pet (and a second pet with Animal Companion), Dire Beasts, Pack
  Leader beasts (bear, boar, wyvern from Howl of the Pack Leader) or Dark Ranger summons
  depending on hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/hunter_beast_mastery.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/hunter/beast-mastery/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/hunter/beast-mastery/abilities-talents-pve-dps>

### Marksmanship

- **Role:** DPS (ranged)
- **How it plays:** A ranged hard-casting spec built around Aimed Shot and Rapid Fire, with
  Precise Shots procs spent on Arcane Shot or Multi-Shot and Trueshot as the main cooldown. It
  plays without a pet by default; talents such as Unbreakable Bond let it keep one.
- **Pets:** The hunter pet only if talented to keep one (check the log's `actors`); Pack
  Leader beasts or Dark Ranger summons depending on hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/hunter_marksmanship.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/hunter/marksmanship/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/hunter/marksmanship/abilities-talents-pve-dps>

### Survival

- **Role:** DPS (melee)
- **How it plays:** A melee Focus spec fighting alongside its pet. Kill Command generates Focus
  and resets, Raptor Strike spends it, Wildfire Bomb is the core AoE and damage-over-time
  ability, and Takedown is the burst cooldown.
- **Pets:** The main hunter pet, Pack Leader beasts (bear, boar, wyvern) with that hero talent.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/hunter_survival.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/hunter/survival/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/hunter/survival/abilities-talents-pve-dps>

## Mage

### Arcane

- **Role:** DPS (ranged)
- **How it plays:** A mana and Arcane Charge caster. Arcane Blast builds charges, Arcane Barrage
  spends them, and Arcane Missiles uses Clearcasting procs. Burst is concentrated in Arcane
  Surge and Touch of the Magi windows, and mana management between bursts is part of the skill.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/mage_arcane.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/mage/arcane/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/mage/arcane/abilities-talents-pve-dps>

### Fire

- **Role:** DPS (ranged)
- **How it plays:** A proc and critical-strike spec. Fireball builds toward Heating Up and Hot
  Streak, which are converted into instant Pyroblasts or Flamestrikes using Fire Blast and
  Scorch. Combustion is the burst window, and how many Hot Streaks fit inside it matters most.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/mage_fire.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/mage/fire/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/mage/fire/abilities-talents-pve-dps>

### Frost

- **Role:** DPS (ranged)
- **How it plays:** A shatter-combo caster. Frostbolt and Flurry set up Winter's Chill and
  Fingers of Frost, which empower Ice Lance and Glacial Spike against frozen targets. Frozen
  Orb, Comet Storm, Ray of Frost, and Blizzard round out the kit.
- **Pets:** Water Elemental (from Summon Water Elemental).
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/mage_frost.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/mage/frost/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/mage/frost/abilities-talents-pve-dps>

## Monk

### Brewmaster

- **Role:** Tank
- **How it plays:** A Stagger tank that converts damage into a delayed damage-over-time effect.
  Keg Smash and Blackout Kick drive the rotation, Purifying Brew clears heavy Stagger, and
  Celestial Brew and Fortifying Brew are active defensives.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/monk_brewmaster.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/monk/brewmaster/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/monk/brewmaster/abilities-talents-pve-tank>

### Mistweaver

- **Role:** Healer
- **How it plays:** A flexible healer that mixes direct and over-time healing (Renewing Mist,
  Vivify, Enveloping Mist) with healing through melee damage. Thunder Focus Tea empowers key
  spells, and Revival and the Celestial summons (Yu'lon or Chi-Ji) are group cooldowns.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/monk/mistweaver/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/monk/mistweaver/abilities-talents-pve-healer>

### Windwalker

- **Role:** DPS (melee)
- **How it plays:** An Energy and Chi melee spec. Tiger Palm builds Chi, Rising Sun Kick, Fists
  of Fury, and Blackout Kick spend it, and the player should avoid repeating the same ability
  back to back (Combo Strikes). Zenith and Invoke Xuen are the burst cooldowns.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/monk_windwalker.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/monk/windwalker/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/monk/windwalker/abilities-talents-pve-dps>

## Paladin

### Holy

- **Role:** Healer
- **How it plays:** A Holy Power healer. Holy Shock and other builders generate Holy Power, Word
  of Glory and Light of Dawn spend it, and Beacon of Light copies healing to a target. Avenging
  Wrath and Aura Mastery are the main cooldowns.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/paladin/holy/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/paladin/holy/abilities-talents-pve-healer>

### Protection

- **Role:** Tank
- **How it plays:** A Holy Power tank. Builders such as Judgment, Hammer of Wrath, and Avenger's
  Shield generate Holy Power, which is spent on Shield of the Righteous for mitigation or Word
  of Glory for healing. Consecration should be kept underfoot, and Ardent Defender and Guardian
  of Ancient Kings are the big defensives.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/paladin_protection.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/paladin/protection/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/paladin/protection/abilities-talents-pve-tank>

### Retribution

- **Role:** DPS (melee)
- **How it plays:** A Holy Power melee spec. Blade of Justice, Judgment, and other builders
  generate Holy Power, which is spent on Templar's Verdict or Divine Storm. Wake of Ashes and
  Avenging Wrath define burst windows.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/paladin_retribution.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/paladin/retribution/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/paladin/retribution/abilities-talents-pve-dps>

## Priest

### Discipline

- **Role:** Healer
- **How it plays:** An atonement healer. Power Word: Shield and Power Word: Radiance apply
  Atonement, and damage spells (Penance, Mind Blast, Smite) then heal those allies. The skill is
  ramping Atonement before predictable damage and timing Evangelism and Power Word: Barrier;
  reactive healing is the exception.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/priest/discipline/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/priest/discipline/abilities-talents-pve-healer>

### Holy

- **Role:** Healer
- **How it plays:** A direct-healing priest. Heal, Flash Heal, and Prayer of Healing reduce the
  cooldowns of the Holy Words (Serenity, Sanctify), which are its strongest heals. Prayer of
  Mending and Divine Hymn round out group healing, and Guardian Spirit is an external defensive.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/priest/holy/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/priest/holy/abilities-talents-pve-healer>

### Shadow

- **Role:** DPS (ranged)
- **How it plays:** An Insanity caster. Shadow Word: Pain and Vampiric Touch must be maintained,
  Mind Blast and Mind Flay generate Insanity, and Shadow Word: Madness spends it. Voidform
  windows concentrate burst.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/priest_shadow.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/priest/shadow/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/priest/shadow/abilities-talents-pve-dps>

## Rogue

### Assassination

- **Role:** DPS (melee)
- **How it plays:** A poison and bleed spec. Garrote and Rupture need high uptime, Mutilate
  builds combo points, and Envenom spends them while keeping its buff active. Deathmark is the
  main cooldown, and bleeds applied under it are amplified.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/rogue_assassination.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/rogue/assassination/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/rogue/assassination/abilities-talents-pve-dps>

### Outlaw

- **Role:** DPS (melee)
- **How it plays:** A fast-paced Energy spec. Roll the Bones provides random buffs worth
  rerolling, Sinister Strike and Pistol Shot procs build combo points, Between the Eyes and
  Dispatch spend them, and Adrenaline Rush is the main cooldown.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/rogue_outlaw.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/rogue/outlaw/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/rogue/outlaw/abilities-talents-pve-dps>

### Subtlety

- **Role:** DPS (melee)
- **How it plays:** A burst spec built around stealth windows. Shadow Dance opens windows where
  Shadowstrike builds combo points and Eviscerate, Secret Technique, or Black Powder spend them.
  Shadow Blades is the main cooldown.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/rogue_subtlety.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/rogue/subtlety/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/rogue/subtlety/abilities-talents-pve-dps>

## Shaman

### Elemental

- **Role:** DPS (ranged)
- **How it plays:** A Maelstrom caster. Flame Shock is maintained, Lava Burst and Lightning Bolt
  build Maelstrom, and Earth Shock or Earthquake spend it. Ascendance or Stormkeeper windows
  concentrate burst.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/shaman_elemental.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/shaman/elemental/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/shaman/elemental/abilities-talents-pve-dps>

### Enhancement

- **Role:** DPS (melee)
- **How it plays:** A melee hybrid that converts melee procs into spells. Maelstrom Weapon
  stacks build from attacks and are spent on instant Lightning Bolt, Chain Lightning, or other
  spells, alongside Stormstrike, Lava Lash, and Crash Lightning. Doom Winds, Ascendance, and
  Primordial Storm are the cooldowns.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/shaman_enhancement.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/shaman/enhancement/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/shaman/enhancement/abilities-talents-pve-dps>

### Restoration

- **Role:** Healer
- **How it plays:** A flexible healer. Riptide and Healing Rain are the core, Chain Heal and
  Healing Wave handle group and single-target damage, and totems (Healing Tide, Spirit Link,
  Cloudburst or Healing Stream) supply the cooldowns.
- **APL:** None (SimulationCraft doesn't model healing). Use the Wowhead guides.
- **Rotation guide:** <https://www.wowhead.com/guide/classes/shaman/restoration/rotation-cooldowns-pve-healer>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/shaman/restoration/abilities-talents-pve-healer>

## Warlock

### Affliction

- **Role:** DPS (ranged)
- **How it plays:** A damage-over-time spec. Agony, Corruption (or Wither), and Unstable
  Affliction need near-permanent uptime, Seed of Corruption spreads Corruption in AoE. Haunt,
  Malefic Grasp, and Drain Soul round out the kit, and Summon Darkglare amplifies the DoTs and
  is the burst window.
- **Pets:** Permanent demon (Imp, Voidwalker, Felhunter, or Sayaad), unless sacrificed with
  Grimoire of Sacrifice; Darkglare.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warlock_affliction.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warlock/affliction/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warlock/affliction/abilities-talents-pve-dps>

### Demonology

- **Role:** DPS (ranged)
- **How it plays:** A summoner. Shadow Bolt and Demonbolt generate Soul Shards, Hand of Gul'dan
  spends them to summon Wild Imps, and Call Dreadstalkers and other summons stack up demons.
  Summon Demonic Tyrant empowers and extends every active demon, so the size of the army at
  Tyrant time is the key measure. Implosion consumes Wild Imps in AoE.
- **Pets:** Felguard (permanent), Wild Imps, Dreadstalkers, Demonic Tyrant, Doomguard, Grimoire
  summons (Fel Ravager, Imp Lord), and other temporary demons from talents.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warlock_demonology.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warlock/demonology/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warlock/demonology/abilities-talents-pve-dps>

### Destruction

- **Role:** DPS (ranged)
- **How it plays:** A Soul Shard caster. Immolate (or Wither) is maintained, Incinerate and
  Conflagrate build shards, and Chaos Bolt or Rain of Fire spend them. Havoc duplicates spells
  onto a second target, and Summon Infernal is the main cooldown.
- **Pets:** Permanent demon (Imp, Voidwalker, Felhunter, or Sayaad), unless sacrificed with
  Grimoire of Sacrifice; Infernal.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warlock_destruction.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warlock/destruction/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warlock/destruction/abilities-talents-pve-dps>

## Warrior

### Arms

- **Role:** DPS (melee)
- **How it plays:** A Rage spec built around Colossus Smash windows. Mortal Strike and Overpower
  are the core, Execute dominates below the execute threshold, and Sweeping Strikes and
  Bladestorm handle cleave. Rend and Deep Wounds should be maintained when talented.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warrior_arms.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warrior/arms/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warrior/arms/abilities-talents-pve-dps>

### Fury

- **Role:** DPS (melee)
- **How it plays:** A dual-wield Rage spec that wants to stay Enraged. Rampage spends Rage and
  triggers Enrage, Bloodthirst and Raging Blow fill, and Recklessness is the main cooldown.
  Whirlwind sets up cleave for multi-target.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warrior_fury.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warrior/fury/rotation-cooldowns-pve-dps>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warrior/fury/abilities-talents-pve-dps>

### Protection

- **Role:** Tank
- **How it plays:** A shield tank. Shield Slam and Thunder Clap generate Rage, which is spent on
  Shield Block and Ignore Pain for mitigation and Revenge for damage. Shield Wall, Last Stand,
  and Avatar are the major cooldowns.
- **APL:** <https://raw.githubusercontent.com/simulationcraft/simc/midnight/ActionPriorityLists/default/warrior_protection.simc>
- **Rotation guide:** <https://www.wowhead.com/guide/classes/warrior/protection/rotation-cooldowns-pve-tank>
- **Abilities guide:** <https://www.wowhead.com/guide/classes/warrior/protection/abilities-talents-pve-tank>
