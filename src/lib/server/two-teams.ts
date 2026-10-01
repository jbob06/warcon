// The Two-team mode rule's pure part: one faction is closed, and everyone on it is moved to
// whichever of the other two has fewer players, so a three-faction server plays as two big teams.
// The game has no two-team setting of its own; its overpopulation lock sends joiners to the closed,
// empty faction, and this rule places them from there. No database, no game server: triggers.ts
// runs the step on each fresh player list, keeps its state in the worker's memory and writes the
// moves to the outbox.
import { settingsFingerprint } from './fingerprint';
import { ApiError, int, str } from './http';
import { MAX_CHAT } from '$lib/chat';

/** How long a move is waited on before it is asked for again (the player is still on the closed faction). */
export const TWO_TEAMS_RETRY_MS = 30_000;
/** A placed player is told once; the note is forgotten after this long away, so a return next day is told again. */
export const TWO_TEAMS_FORGET_MS = 2 * 3600_000;
/**
 * Moves asked for per second of the player-list cadence. Each move is two game requests (move,
 * then kill), so a full server's sort at a match start goes out over half a minute instead of at
 * once, under the listener's limit on requests from one address.
 */
export const TWO_TEAMS_MOVES_PER_SECOND = 3;
/**
 * The most moves one look asks for, whatever its cadence: the first look with players back after a
 * map load comes at the idle cadence (30 s), which would otherwise let most of a server go at once.
 */
export const TWO_TEAMS_MAX_MOVES_PER_LOOK = 6;
/**
 * A player asked to move this many times within TWO_TEAMS_ASK_WINDOW_MS is left where they are
 * until the window passes: something keeps putting them back, and every move kills them.
 */
export const TWO_TEAMS_MAX_ASKS = 3;
export const TWO_TEAMS_ASK_WINDOW_MS = 10 * 60_000;

export interface TwoTeamsConfig {
	/** the faction nobody plays on; its players are moved off it */
	closedFaction: string;
	/** what players are told the open factions are called, by faction ('' keeps the faction name) */
	names: Record<string, string>;
	/** whispered once a moved player lands, with {team}; '' sends nothing */
	message: string;
	/**
	 * Keep clans together: a player whose clan tag is mostly on one open side is placed there, while
	 * that would leave the side at most this many players ahead of the other. Absent on a rule that
	 * does not group clans, so such a rule's fingerprint is what it was before the setting existed.
	 */
	clanGap?: number;
}

/** The most a side may be let ahead for a clan's sake. */
export const TWO_TEAMS_MAX_CLAN_GAP = 10;

/**
 * A player's clan tag, as the game shows it: square brackets at the front of the name, "[WOLF] Dan".
 * Folded, so [wolf] and [WOLF] are one clan; null without one. Twelve characters at most: a longer
 * bracket is a name, not a tag.
 */
export function clanTag(name: string): string | null {
	const m = /^\s*\[([^\]]{1,12})\]/.exec(name);
	return (m && m[1].normalize('NFKC').trim().toUpperCase()) || null;
}

export function validateTwoTeams(c: Record<string, unknown>): TwoTeamsConfig {
	const closedFaction = str(c.closedFaction, 100);
	if (!closedFaction) throw new ApiError(400, 'Pick the faction to close.');
	const names: Record<string, string> = {};
	if (c.names && typeof c.names === 'object')
		for (const [k, v] of Object.entries(c.names as Record<string, unknown>).slice(0, 8)) {
			const faction = str(k, 100);
			const name = str(v, 40);
			if (faction && name && faction !== closedFaction) names[faction] = name;
		}
	const clanGap = int(c.clanGap, 0, 0, TWO_TEAMS_MAX_CLAN_GAP);
	return {
		closedFaction,
		names,
		message: str(c.message, MAX_CHAT),
		...(clanGap ? { clanGap } : {})
	};
}

/**
 * A short fingerprint of a rule's settings. Each move and whisper carries the one it was decided
 * under, so delivery can tell a row decided before the settings changed.
 */
export const twoTeamsSettingsKey = (cfg: TwoTeamsConfig): string => settingsFingerprint(cfg);

/** What the rule remembers between player lists (the worker's memory, per rule). */
export interface TwoTeamsState {
	/** moves asked for and not yet seen landed: SteamID -> target faction and when */
	moving: Map<string, { to: string; at: number }>;
	/** placed players already told where they went, when there is a whisper: SteamID -> last seen */
	told: Map<string, number>;
	/** when each player was asked to move within TWO_TEAMS_ASK_WINDOW_MS, oldest first */
	asked: Map<string, number[]>;
	/** players left on the closed faction for being asked too often (said once, in `stopped`) */
	capped: Set<string>;
}

export const emptyTwoTeamsState = (): TwoTeamsState => ({
	moving: new Map(),
	told: new Map(),
	asked: new Map(),
	capped: new Set()
});

export interface TwoTeamsStep {
	state: TwoTeamsState;
	/** players to move now, and where; `clan` is the tag a player was placed with, when one decided the side */
	moves: { steamId: string; name: string; from: string; to: string; clan?: string }[];
	/** moved players now on their side and not told yet */
	whispers: { steamId: string; name: string; faction: string }[];
	/** players the rule has just stopped moving for being asked too often */
	stopped: { steamId: string; name: string }[];
}

/**
 * One fresh player list. `open` is the two factions players are placed on (the match's factions
 * minus the closed one); at most `maxMoves` moves are asked for. Players already being moved count
 * toward their target, so a burst at a match start splits evenly; a move not seen landed after
 * TWO_TEAMS_RETRY_MS is asked for again.
 *
 * With `clanGap`, a player with a clan tag goes to the open side most of that clan is on (players
 * there, and moves on their way there), while that leaves the side at most `clanGap` ahead of the
 * other; a clan split evenly, or one that would tip the sides further, is placed as anyone else. So a
 * clan that lands on the closed faction together at a match start follows its first member. Only a
 * player's first ask in the window is placed this way: a move that did not land is asked for again
 * toward the smaller side, as it was before clans were looked at.
 */
export function twoTeamsStep(
	cfg: TwoTeamsConfig,
	previous: TwoTeamsState,
	players: { steamId: string; name: string; faction: string | null }[],
	open: string[],
	now: number,
	maxMoves: number,
	random: () => number = Math.random
): TwoTeamsStep {
	const state: TwoTeamsState = {
		moving: new Map(previous.moving),
		told: new Map(previous.told),
		asked: new Map(previous.asked),
		capped: new Set(previous.capped)
	};
	const moves: TwoTeamsStep['moves'] = [];
	const whispers: TwoTeamsStep['whispers'] = [];
	const stopped: TwoTeamsStep['stopped'] = [];
	const counts = new Map(open.map((f) => [f, 0]));
	for (const p of players)
		if (p.faction && counts.has(p.faction)) counts.set(p.faction, counts.get(p.faction)! + 1);

	const on = new Set<string>();
	for (const p of players) {
		on.add(p.steamId);
		// Landed (or placed by hand meanwhile): the move is done; with a whisper, tell them once.
		const landed = !!p.faction && counts.has(p.faction) && state.moving.has(p.steamId);
		if (landed) state.moving.delete(p.steamId);
		if (!cfg.message) continue;
		if (landed && !state.told.has(p.steamId))
			whispers.push({ steamId: p.steamId, name: p.name, faction: p.faction! });
		if (landed || state.told.has(p.steamId)) state.told.set(p.steamId, now);
	}
	for (const [id, seen] of state.told)
		if (!on.has(id) && now - seen > TWO_TEAMS_FORGET_MS) state.told.delete(id);
	for (const [id, m] of state.moving) if (now - m.at >= TWO_TEAMS_RETRY_MS) state.moving.delete(id);
	for (const [id, times] of state.asked) {
		const recent = times.filter((t) => now - t < TWO_TEAMS_ASK_WINDOW_MS);
		if (recent.length) state.asked.set(id, recent);
		else state.asked.delete(id);
	}
	for (const id of state.capped)
		if ((state.asked.get(id)?.length ?? 0) < TWO_TEAMS_MAX_ASKS) state.capped.delete(id);

	if (open.length < 2) return { state, moves, whispers, stopped };
	// Moves still in flight count toward their side before anyone new is placed.
	for (const p of players) {
		const m = state.moving.get(p.steamId);
		if (p.faction === cfg.closedFaction && m && counts.has(m.to))
			counts.set(m.to, counts.get(m.to)! + 1);
	}
	// Each clan's players per open side, those on their way there included.
	const gap = cfg.clanGap ?? 0;
	const clans = new Map<string, Map<string, number>>();
	const joins = (tag: string, side: string) => {
		const sides = clans.get(tag) ?? new Map<string, number>();
		clans.set(tag, sides.set(side, (sides.get(side) ?? 0) + 1));
	};
	if (gap > 0)
		for (const p of players) {
			const tag = clanTag(p.name);
			const side = p.faction === cfg.closedFaction ? state.moving.get(p.steamId)?.to : p.faction;
			if (tag && side && counts.has(side)) joins(tag, side);
		}
	for (const p of players) {
		if (p.faction !== cfg.closedFaction || state.moving.has(p.steamId)) continue;
		const times = state.asked.get(p.steamId) ?? [];
		if (times.length >= TWO_TEAMS_MAX_ASKS) {
			if (!state.capped.has(p.steamId)) {
				state.capped.add(p.steamId);
				stopped.push({ steamId: p.steamId, name: p.name });
			}
			continue;
		}
		if (moves.length >= maxMoves) continue;
		const low = Math.min(...counts.values());
		const ties = open.filter((f) => counts.get(f) === low);
		let to = ties[Math.min(ties.length - 1, Math.floor(random() * ties.length))];
		const tag = gap > 0 ? clanTag(p.name) : null;
		let clan: string | undefined;
		if (tag && !times.length) {
			// The side with more of the clan than any other, if joining it keeps the sides within the gap.
			const sides = clans.get(tag);
			const most = Math.max(0, ...(sides?.values() ?? []));
			const held = open.filter((f) => most > 0 && sides!.get(f) === most);
			const others = open.filter((f) => f !== held[0]).map((f) => counts.get(f)!);
			if (held.length === 1 && counts.get(held[0])! + 1 - Math.min(...others) <= gap) {
				to = held[0];
				clan = tag;
			}
		}
		if (tag) joins(tag, to);
		counts.set(to, counts.get(to)! + 1);
		state.moving.set(p.steamId, { to, at: now });
		state.asked.set(p.steamId, [...times, now]);
		moves.push({
			steamId: p.steamId,
			name: p.name,
			from: cfg.closedFaction,
			to,
			...(clan ? { clan } : {})
		});
	}
	return { state, moves, whispers, stopped };
}

/** What players are told a faction is called. */
export const teamName = (cfg: TwoTeamsConfig, faction: string): string =>
	(Object.hasOwn(cfg.names, faction) && cfg.names[faction]) || faction;
