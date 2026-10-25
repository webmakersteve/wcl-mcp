---
name: dungeon-analyzer
description: Analyze a World of Warcraft Mythic+ dungeon run from a Warcraft Logs report or local combat log. Use whenever the wcl MCP tools are used to review a key, a pull, a boss fight, deaths, avoidable damage, interrupts, or dispels in a dungeon. Lists the current season's dungeons with a short description, their bosses, the ids that identify them in the database, and links to Method's dungeon guides and ability trackers for the mechanics that matter.
---

# Dungeon analyzer

Use this skill to judge a Mythic+ run against what each dungeon demands. The run's data comes
from the wcl MCP tools; the mechanics live in Method's guides, linked from the season file
instead of copied because they change with every season and tuning pass. Fetch the guide for
the dungeon you're analyzing rather than relying on memory.

## Current season

Read [MidnightSeason2.md](MidnightSeason2.md) first. It lists the season's dungeons with a
short description, their bosses, the ids that identify them in the database, and links to
each dungeon's Method guide and ability tracker. If a report is from a dungeon that file
doesn't list, check <https://www.method.gg/guides#mythic-plus-guides> for the current pool and
its guide.

## How to analyze a run

1. **Identify the dungeon.** Match `fights.game_zone_id` (the game's instance id) to the
   dungeons in the season file; local logs also carry `fights.challenge_mode_id`. Don't match
   on `encounter_id`, which uses Warcraft Logs' unstable numbering for keys. `fights.name` holds
   the boss or segment name and `fights.keystone_level` the key level.
2. **Load the references for that dungeon:**
   - **Dungeon guide.** Covers every trash pack and boss: its abilities, how to handle them,
     and which ones are dangerous. Its "Important Abilities" section lists the abilities most
     likely to kill a group, each with the mob that casts it. Fetch it with WebFetch.
   - **Ability tracker.** Lists every mob ability with flags for how it should be handled:
     Interrupt, Stop (ended by crowd control), Avoid, Frontal, Party Damage, Tank Buster,
     Debuff (with its dispel type), Buff (removable by purge or soothe), Add Spawn, CC Effect,
     Special (combat drop, racial, line of sight, freedom), and Important. Each ability links
     to Wowhead as `https://www.wowhead.com/spell=<id>/...`, so the spell id there matches
     `ability_game_id` in the log. The flags are in the page's HTML attributes
     (`data-abilityTypes` on each ability and the icons' `title`), not in its visible text,
     so fetch the raw HTML (for example with `curl`) when you need them; WebFetch's text
     version drops them.
3. **Compare the run to the references.** Useful measures, all queryable from the event
   tables:
   - **Interrupts and stops:** how many casts of Interrupt- or Stop-flagged abilities
     completed, who was in range with an interrupt available, and who did the interrupting.
   - **Avoidable damage:** damage taken from Avoid and Frontal abilities, per player. Repeated
     hits from the same mechanic matter more than one-off mistakes.
   - **Dispels and removals:** how long dispellable debuffs (and purgeable or soothable mob
     buffs) stayed up, and whether the group had the right dispel type.
   - **Deaths:** for each death, the damage taken in the seconds before it, which mechanic
     dealt the killing blow, and whether a defensive or healing cooldown was available.
   - **Boss mechanics:** whether the soaks, adds, positioning, and add priorities the guide
     describes were handled, read from the boss fight's events.
   - **Route and pace:** use `import_mdt_route` to compare the pulls against an MDT route and
     `get_pull_insights` for Wipefest's pull analysis. Compare the run's length to the timer.
   - Use `lookup_spells` to name spell ids before comparing them to the guide.
4. **Account for context.** Key level and affixes change what's dangerous. Credit pet damage
   and casts to their owner (see the `class-analyzer` skill), and use that skill when the
   question is about how a specific player played their spec.
5. **Report specific findings** with the pull or boss, timestamp, player, and the guide
   entry that supports each one.
