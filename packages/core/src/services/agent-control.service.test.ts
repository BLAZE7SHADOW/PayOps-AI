import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../container';
import { fixedClock } from '../testing/fixed-clock';
import { startTestDatabase, type TestDatabase } from '../testing/pglite';
import { readAgentControlMode } from './agent-control.service';

let t: TestDatabase;
let core: Core;
const clock = fixedClock('2026-09-28T12:00:00.000Z');
const manager = { id: 'usr_mgr', name: 'Meera Iyer' };

beforeAll(async () => {
  t = await startTestDatabase();
  core = createCore({ db: t.db, clock });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('AgentControlService', () => {
  it('is NORMAL until someone changes it', async () => {
    expect(await core.agentControl.get()).toEqual({ mode: 'NORMAL', reason: '', changedByName: null, changedAt: null });
    expect(await readAgentControlMode(core.db)).toBe('NORMAL');
  });

  it('pauses the agent with a reason and records who and when', async () => {
    const item = await core.agentControl.set({ mode: 'PAUSED', reason: 'Gateway outage, wait for it to clear.' }, manager);
    expect(item).toMatchObject({ mode: 'PAUSED', reason: 'Gateway outage, wait for it to clear.', changedByName: 'Meera Iyer', changedAt: '2026-09-28T12:00:00.000Z' });
    expect(await readAgentControlMode(core.db)).toBe('PAUSED');
  });

  it('keeps one row when the mode changes again, and clears the reason on NORMAL', async () => {
    await core.agentControl.set({ mode: 'PAUSED', reason: 'Investigating a spike.' }, manager);
    await core.agentControl.set({ mode: 'PROPOSE_ONLY', reason: 'Reviewing every fix for a day.' }, manager);
    expect((await core.agentControl.get()).mode).toBe('PROPOSE_ONLY');
    await core.agentControl.set({ mode: 'NORMAL', reason: 'ignored' }, manager);
    expect(await core.agentControl.get()).toMatchObject({ mode: 'NORMAL', reason: '' });
  });

  it('writes an audit event for every change', async () => {
    await core.agentControl.set({ mode: 'PAUSED', reason: 'Gateway outage.' }, manager);
    const audit = await core.audit.list({ limit: 10 });
    expect(audit.items.find((a) => a.action === 'agent.control_changed')).toMatchObject({
      entityType: 'agent',
      entityId: 'global',
      summary: 'Set the agent to PAUSED: Gateway outage.',
    });
  });
});
