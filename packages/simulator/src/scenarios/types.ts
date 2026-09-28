import type { ScenarioContext } from '../context';
import type { WorldCustomer } from '../world';

/** Writes one scenario's rows inside the context's transaction. */
export type ScenarioWriter = (ctx: ScenarioContext) => Promise<void>;

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const MIN = 60 * 1000;

export const before = (ctx: ScenarioContext, ms: number): Date => new Date(ctx.now.getTime() - ms);

export const pickCustomer = (ctx: ScenarioContext): WorldCustomer => ctx.ids.pick(ctx.world.customers);
