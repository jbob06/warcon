import { afterEach, describe, expect, test } from 'bun:test';
import { evaluateTriggers, forgetRuleMemory, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import { validateTwoTeams } from './two-teams';
import type { Env } from './env';
import type { Player } from '$lib/types';

const player = (steamId: string, faction: string | null): Player => ({
	name: `P${steamId}`,
	steamId,
	faction,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const row = (config: Record<string, unknown>) =>
	({
		id: 'two-teams-rule',
		kind: 'two_teams',
		name: 'Two teams',
		config: validateTwoTeams(config),
		state: null
	}) as unknown as TriggerRow;
const tick = (players: Player[], at: number, playersIntervalMs = 1000) =>
	({
		server: { id: 'srv', name: 'Server' },
		status: {
			serverName: 'Server',
			map: 'Map',
			playerCount: players.length,
			maxPlayers: 100,
			scores: ['Lonestar', 'Valkyra', 'Manticore'].map((name) => ({ name, colorHex: '', score: 0 }))
		},
		players,
		playersObserved: true,
		playersIntervalMs,
		ts: new Date(at)
	}) as unknown as TickContext;
const CLOSED = { closedFaction: 'Lonestar', message: '' };
const everyone = Array.from({ length: 10 }, (_, i) => player(String(i), 'Lonestar'));
const moved = (ev: Awaited<ReturnType<typeof evaluateTriggers>>) =>
	ev.intents.filter((i) => i.action === 'changeTeam').map((i) => i.target);
/** One look whose moves are written, as the worker's observation commits them. */
const look = async (rule: TriggerRow, ctx: TickContext) => {
	const ev = await evaluateTriggers({} as Env, ctx, [rule]);
	for (const f of ev.afterCommit ?? []) f();
	return ev;
};

afterEach(() => forgetRuleMemory());

describe('the Two-team mode rule', () => {
	test('keeps its state in the worker, never on the row, and paces its moves by the cadence', async () => {
		const rule = row(CLOSED);
		const a = await look(rule, tick(everyone, 0));
		expect(moved(a)).toEqual(['0', '1', '2']);
		expect(a.updates).toEqual([
			{ id: rule.id, lastFiredAt: new Date(0), lastResult: 'Moving 3 players' }
		]);
		expect(rule.state).toBeNull();
		// the three asked are in flight, so the next look asks for the next three
		const b = await look(rule, tick(everyone, 1000));
		expect(moved(b)).toEqual(['3', '4', '5']);
		// a slower cadence asks for more at once
		forgetRuleMemory();
		const slow = await look(rule, tick(everyone, 0, 2000));
		expect(moved(slow)).toHaveLength(6);
		// the first look with players back after a map load comes at the idle cadence
		forgetRuleMemory();
		const idle = await look(rule, tick(everyone, 0, 30_000));
		expect(moved(idle)).toHaveLength(6);
	});

	test('a look whose write fails is decided again at the next one', async () => {
		const rule = row(CLOSED);
		const failed = await evaluateTriggers({} as Env, tick(everyone, 0), [rule]);
		expect(moved(failed)).toEqual(['0', '1', '2']);
		// the observation's transaction rolled back: its afterCommit never ran
		const again = await look(rule, tick(everyone, 1000));
		expect(moved(again)).toEqual(['0', '1', '2']);
		expect(moved(await look(rule, tick(everyone, 2000)))).toEqual(['3', '4', '5']);
	});

	test('a change to its settings starts it over; a new name does not', async () => {
		const a = await look(row(CLOSED), tick(everyone, 0));
		expect(moved(a)).toEqual(['0', '1', '2']);
		const renamed = { ...row(CLOSED), name: 'Renamed' } as TriggerRow;
		expect(moved(await look(renamed, tick(everyone, 1000)))).toEqual(['3', '4', '5']);
		const edited = row({ ...CLOSED, message: 'You are on {team}.' });
		expect(moved(await look(edited, tick(everyone, 2000)))).toEqual(['0', '1', '2']);
	});

	test('says once that it has left a player on the closed faction', async () => {
		const rule = row(CLOSED);
		const results: string[] = [];
		for (let n = 0; n < 12; n++) {
			const faction = n % 2 === 0 ? 'Lonestar' : 'Valkyra';
			const ev = await look(rule, tick([player('7', faction)], n * 2000));
			results.push(...ev.updates.map((u) => u.lastResult ?? ''));
		}
		expect(results.filter((r) => r.startsWith('Moving'))).toHaveLength(3);
		expect(results.filter((r) => r.startsWith('Left'))).toEqual([
			'Left P7 on Lonestar: asked to move 3 times in 10 min'
		]);
	});

	test('says so even on a look that also moves other players', async () => {
		const rule = row(CLOSED);
		const results: string[] = [];
		// P7 keeps being put back while newcomers keep arriving on the closed faction
		for (let n = 0; n < 8; n++) {
			const players = [
				player('7', n % 2 === 0 ? 'Lonestar' : 'Valkyra'),
				player(String(100 + n), 'Lonestar')
			];
			const ev = await look(rule, tick(players, n * 2000));
			results.push(...ev.updates.map((u) => u.lastResult ?? ''));
		}
		expect(results.filter((r) => r.includes('left P7'))).toEqual([
			'Moving P106; left P7 on Lonestar: asked to move 3 times in 10 min'
		]);
	});

	test('with clans kept together, a move says which clan decided the side', async () => {
		const rule = row({ ...CLOSED, clanGap: 3 });
		const players = [
			{ ...player('1', 'Valkyra'), name: '[WOLF] A' },
			player('2', 'Valkyra'),
			{ ...player('3', 'Lonestar'), name: '[WOLF] C' },
			player('4', 'Lonestar')
		];
		const ev = await look(rule, tick(players, 0));
		const moves = ev.intents.filter((i) => i.action === 'changeTeam');
		expect(moves.map((i) => [i.params.faction, i.okMessage, i.detail])).toEqual([
			[
				'Valkyra',
				'Moved [WOLF] C to Valkyra, with [WOLF].',
				{ name: '[WOLF] C', from: 'Lonestar', to: 'Valkyra', clan: 'WOLF' }
			],
			['Manticore', 'Moved P4 to Manticore.', { name: 'P4', from: 'Lonestar', to: 'Manticore' }]
		]);
	});
});
