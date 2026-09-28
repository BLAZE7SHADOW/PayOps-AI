import { bigint, timestamp } from 'drizzle-orm/pg-core';

/** Money: bigint paise, surfaced to TS as a safe integer number. */
export const money = (name?: string) =>
  name ? bigint(name, { mode: 'number' }) : bigint({ mode: 'number' });

export const tstz = (name?: string) =>
  name ? timestamp(name, { withTimezone: true, mode: 'date' }) : timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => tstz().notNull().defaultNow();
export const updatedAt = () =>
  tstz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
