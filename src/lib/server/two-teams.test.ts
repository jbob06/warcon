import { describe, expect, test } from 'bun:test';
import {
	clanTag,
	emptyTwoTeamsState,
	TWO_TEAMS_ASK_WINDOW_MS,
	TWO_TEAMS_FORGET_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_MAX_CLAN_GAP,
	TWO_TEAMS_RETRY_MS,
	teamName,
	twoTeamsSettingsKey,
	twoTeamsStep,
	validateTwoTeams,
	type TwoTeamsConfig,
	type TwoTeamsState
} from './two-teams';

const cfg: TwoTeamsConfig = {
	closedFaction: 'Lonestar',
	names: { Valkyra: 'Red', Manticore: 'Green' },
	message: 'You are on {team}.'
};
const OPEN = ['Valkyra', 'Manticore'];
const ALL = 100;
const p = (id: string, faction: string | null) => ({ steamId: id, name: `P${id}`, faction });
const first = () => 0;
const step = (
	state: TwoTeamsState,
	players: ReturnType<typeof p>[],
	now: number,
	maxMoves = ALL,
	c = cfg
) => twoTeamsStep(c, state, players, OPEN, now, maxMoves, first);

describe('validateTwoTeams', () => {
	test('needs a closed faction', () => {
		expect(() => validateTwoTeams({})).toThrow('faction');
	});
	test('keeps names for the open factions only, and an empty message', () => {
		expect(
			validateTwoTeams({
				closedFaction: 'Lonestar',
				names: { Lonestar: 'Blue', Valkyra: 'Red', Manticore: '' }
			})
		).toEqual({ closedFaction: 'Lonestar', names: { Valkyra: 'Red' }, message: '' });
	});
});

describe('twoTeamsStep', () => {
	test('moves everyone on the closed faction, filling the smaller side first', () => {
		const players = [
			p('1', 'Valkyra'),
			p('2', 'Valkyra'),
			p('3', 'Lonestar'),
			p('4', 'Lonestar'),
			p('5', 'Lonestar')
		];
		const r = step(emptyTwoTeamsState(), players, 0);
		expect(r.moves.map((m) => m.to)).toEqual(['Manticore', 'Manticore', 'Valkyra']);
	});

	test('does nothing with fewer than two open factions', () => {
		const r = twoTeamsStep(cfg, emptyTwoTeamsState(), [p('1', 'Lonestar')], ['Valkyra'], 0, ALL);
		expect(r.moves).toEqual([]);
	});

	test('leaves unplaced players and the open sides alone', () => {
		const r = step(
			emptyTwoTeamsState(),
			[p('1', null), p('2', 'Valkyra'), p('3', 'Valkyra'), p('4', 'Valkyra')],
			0
		);
		expect(r.moves).toEqual([]);
	});

	test('a move in flight is not asked for again, and counts toward its side', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		expect(a.moves).toHaveLength(1);
		const to = a.moves[0].to;
		const b = step(a.state, [p('1', 'Lonestar'), p('2', 'Lonestar')], 5000);
		expect(b.moves).toEqual([expect.objectContaining({ steamId: '2' })]);
		expect(b.moves[0].to).not.toBe(to);
	});

	test('a move that has not landed is retried', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', 'Lonestar')], TWO_TEAMS_RETRY_MS);
		expect(b.moves).toHaveLength(1);
	});

	test('a landed player is whispered once, and not again after the next match re-sort', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', a.moves[0].to)], 5000);
		expect(b.whispers).toEqual([{ steamId: '1', name: 'P1', faction: a.moves[0].to }]);
		const c = step(b.state, [p('1', 'Lonestar')], 60_000);
		const d = step(c.state, [p('1', c.moves[0].to)], 65_000);
		expect(d.whispers).toEqual([]);
	});

	test('no whisper and nothing remembered without a message, and none for players it never moved', () => {
		const quiet = { ...cfg, message: '' };
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0, ALL, quiet);
		const b = step(a.state, [p('1', 'Valkyra')], 5000, ALL, quiet);
		expect(b.whispers).toEqual([]);
		expect(b.state.told.size).toBe(0);
		expect(step(emptyTwoTeamsState(), [p('2', 'Valkyra')], 0).whispers).toEqual([]);
	});

	test('a told player is forgotten after long enough away', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', 'Valkyra')], 1000);
		expect(b.state.told.has('1')).toBe(true);
		const gone = step(b.state, [], 1000 + TWO_TEAMS_FORGET_MS + 1);
		expect(gone.state.told.size).toBe(0);
	});

	test('asks for at most the given number of moves per look; the rest go at the next looks', () => {
		const everyone = Array.from({ length: 10 }, (_, i) => p(String(i), 'Lonestar'));
		const a = step(emptyTwoTeamsState(), everyone, 0, 4);
		expect(a.moves.map((m) => m.steamId)).toEqual(['0', '1', '2', '3']);
		// the four asked are still on their way; the next four are placed against them
		const b = step(a.state, everyone, 1000, 4);
		expect(b.moves.map((m) => m.steamId)).toEqual(['4', '5', '6', '7']);
		const sides = [...a.moves, ...b.moves].map((m) => m.to);
		expect(sides.filter((s) => s === 'Valkyra')).toHaveLength(4);
	});

	test('a player put back again and again is asked at most three times in ten minutes', () => {
		let state = emptyTwoTeamsState();
		let asks = 0;
		const stopped: string[] = [];
		// every look: back on the closed faction, as if the game kept putting them there
		for (let look = 0; look < 30; look++) {
			const faction = look % 2 === 0 ? 'Lonestar' : 'Valkyra';
			const r = step(state, [p('1', faction)], look * 2000);
			state = r.state;
			asks += r.moves.length;
			stopped.push(...r.stopped.map((s) => s.steamId));
		}
		expect(asks).toBe(TWO_TEAMS_MAX_ASKS);
		expect(stopped).toEqual(['1']);
		// once the window has passed, the rule tries again
		const later = step(state, [p('1', 'Lonestar')], TWO_TEAMS_ASK_WINDOW_MS + 60_000);
		expect(later.moves).toHaveLength(1);
		expect(later.state.capped.has('1')).toBe(false);
	});
});

describe('clanTag', () => {
	test('reads square brackets at the front of a name, folded', () => {
		expect(clanTag('[WOLF] Dan')).toBe('WOLF');
		expect(clanTag('  [wolf]Dan')).toBe('WOLF');
		expect(clanTag('[ w f ] Dan')).toBe('W F');
	});
	test('is null without a tag, for an empty or overlong bracket, and for one later in the name', () => {
		expect(clanTag('Dan')).toBeNull();
		expect(clanTag('[] Dan')).toBeNull();
		expect(clanTag('[   ] Dan')).toBeNull();
		expect(clanTag('[the strongest soldier] Dan')).toBeNull();
		expect(clanTag('Dan [WOLF]')).toBeNull();
	});
});

describe('twoTeamsStep keeping clans together', () => {
	const clans = { ...cfg, clanGap: 3 };
	const named = (id: string, name: string, faction: string | null) => ({
		steamId: id,
		name,
		faction
	});
	const go = (state: TwoTeamsState, players: ReturnType<typeof named>[], now = 0, c = clans) =>
		twoTeamsStep(c, state, players, OPEN, now, ALL, first);

	test('a rule without the setting places a clan member on the smaller side, as before', () => {
		const players = [
			named('1', '[WOLF] A', 'Valkyra'),
			named('2', 'B', 'Valkyra'),
			named('3', '[WOLF] C', 'Lonestar')
		];
		const r = twoTeamsStep(cfg, emptyTwoTeamsState(), players, OPEN, 0, ALL, first);
		expect(r.moves).toEqual([
			{ steamId: '3', name: '[WOLF] C', from: 'Lonestar', to: 'Manticore' }
		]);
	});

	test('a player joins the side their clan is on, though it is the larger one', () => {
		const players = [
			named('1', '[WOLF] A', 'Valkyra'),
			named('2', 'B', 'Valkyra'),
			named('3', '[wolf] C', 'Lonestar'),
			named('4', 'D', 'Lonestar')
		];
		const r = go(emptyTwoTeamsState(), players);
		expect(r.moves).toEqual([
			{ steamId: '3', name: '[wolf] C', from: 'Lonestar', to: 'Valkyra', clan: 'WOLF' },
			{ steamId: '4', name: 'D', from: 'Lonestar', to: 'Manticore' }
		]);
	});

	test('a clan that lands on the closed faction together follows its first member', () => {
		const players = Array.from({ length: 4 }, (_, i) =>
			named(String(i), `[WOLF] ${i}`, 'Lonestar')
		);
		const r = go(emptyTwoTeamsState(), players);
		// the first is placed as anyone; the next two join it; a fourth would put the side 4 ahead
		expect(r.moves.map((m) => m.to)).toEqual(['Valkyra', 'Valkyra', 'Valkyra', 'Manticore']);
		expect(r.moves.map((m) => m.clan)).toEqual([undefined, 'WOLF', 'WOLF', undefined]);
	});

	test('members still on their way count: the rest of a clan follows at the next look', () => {
		const a = go(emptyTwoTeamsState(), [named('1', '[WOLF] A', 'Lonestar')]);
		const b = go(
			a.state,
			[named('1', '[WOLF] A', 'Lonestar'), named('2', '[WOLF] B', 'Lonestar')],
			1000
		);
		expect(b.moves).toEqual([
			expect.objectContaining({ steamId: '2', to: a.moves[0].to, clan: 'WOLF' })
		]);
	});

	test('never lets the clan side further ahead than the gap', () => {
		const players = [
			...Array.from({ length: 5 }, (_, i) => named(`v${i}`, `[WOLF] V${i}`, 'Valkyra')),
			...Array.from({ length: 2 }, (_, i) => named(`m${i}`, `M${i}`, 'Manticore')),
			named('x', '[WOLF] X', 'Lonestar')
		];
		// 5 v 2: joining the clan would make it 6 v 2
		expect(go(emptyTwoTeamsState(), players).moves).toEqual([
			{ steamId: 'x', name: '[WOLF] X', from: 'Lonestar', to: 'Manticore' }
		]);
		// a wider gap lets them through
		expect(go(emptyTwoTeamsState(), players, 0, { ...cfg, clanGap: 4 }).moves[0]).toEqual(
			expect.objectContaining({ to: 'Valkyra', clan: 'WOLF' })
		);
	});

	test('a clan split evenly has no side, and is placed on the smaller one', () => {
		const players = [
			named('1', '[WOLF] A', 'Valkyra'),
			named('2', '[WOLF] B', 'Manticore'),
			named('3', 'C', 'Manticore'),
			named('4', '[WOLF] D', 'Lonestar')
		];
		expect(go(emptyTwoTeamsState(), players).moves).toEqual([
			{ steamId: '4', name: '[WOLF] D', from: 'Lonestar', to: 'Valkyra' }
		]);
	});

	test('a move asked for a second time goes to the smaller side, not back to the clan', () => {
		const players = [
			named('1', '[WOLF] A', 'Valkyra'),
			named('2', 'B', 'Valkyra'),
			named('3', '[WOLF] C', 'Lonestar')
		];
		const a = go(emptyTwoTeamsState(), players);
		expect(a.moves[0]).toEqual(expect.objectContaining({ to: 'Valkyra', clan: 'WOLF' }));
		// still on the closed faction once the wait is over: the move did not land
		const b = go(a.state, players, TWO_TEAMS_RETRY_MS);
		expect(b.moves).toEqual([
			{ steamId: '3', name: '[WOLF] C', from: 'Lonestar', to: 'Manticore' }
		]);
	});

	test('validateTwoTeams keeps a gap from 1 to the limit, and leaves the setting out when it is off', () => {
		const base = { closedFaction: 'Lonestar' };
		expect(validateTwoTeams({ ...base, clanGap: 3 }).clanGap).toBe(3);
		expect(validateTwoTeams({ ...base, clanGap: 99 }).clanGap).toBe(TWO_TEAMS_MAX_CLAN_GAP);
		for (const off of [0, -2, '', null, 'x'])
			expect('clanGap' in validateTwoTeams({ ...base, clanGap: off })).toBe(false);
		// so a rule saved before the setting existed keeps its fingerprint when saved again
		expect(twoTeamsSettingsKey(validateTwoTeams({ ...cfg, clanGap: 0 }))).toBe(
			twoTeamsSettingsKey(cfg)
		);
		expect(twoTeamsSettingsKey({ ...cfg, clanGap: 3 })).not.toBe(twoTeamsSettingsKey(cfg));
	});
});

test('teamName falls back to the faction, never to an inherited property', () => {
	expect(teamName(cfg, 'Valkyra')).toBe('Red');
	expect(teamName({ ...cfg, names: {} }, 'Valkyra')).toBe('Valkyra');
	expect(teamName(cfg, 'constructor')).toBe('constructor');
});

test("a rule's settings fingerprint does not depend on key order, and changes with any setting", () => {
	const key = twoTeamsSettingsKey(cfg);
	expect(
		twoTeamsSettingsKey({
			message: cfg.message,
			names: { ...cfg.names },
			closedFaction: 'Lonestar'
		})
	).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, names: { Manticore: 'Green', Valkyra: 'Red' } })).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, closedFaction: 'Valkyra' })).not.toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, message: '' })).not.toBe(key);
});
