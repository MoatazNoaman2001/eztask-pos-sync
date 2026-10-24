import { sql } from 'drizzle-orm';
import { bigserial, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Full design and reasoning: docs/schema.md

export const checkStatus = pgEnum('check_status', ['open', 'paid', 'cancelled']);
/** What we want the POS to hold for a check. Written only by /pay and /cancel. */
export const syncDesired = pgEnum('sync_desired', ['present', 'absent']);
/** What we know the POS holds. `unknown` = a create was sent and we never heard back. */
export const posState = pgEnum('pos_state', ['none', 'unknown', 'created', 'cancelled']);
export const syncStatus = pgEnum('sync_status', ['pending', 'retrying', 'failed', 'synced']);

export interface CheckItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export const checks = pgTable('checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  restaurantId: text('restaurant_id').notNull(),
  items: jsonb('items').$type<CheckItem[]>().notNull(),
  total: numeric('total', { precision: 12, scale: 2, mode: 'number' }).notNull(),
  status: checkStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The outbox: one row per paid check, driving its delivery to the POS. */
export const posSync = pgTable(
  'pos_sync',
  {
    checkId: uuid('check_id')
      .primaryKey()
      .references(() => checks.id),
    restaurantId: text('restaurant_id').notNull(),
    desired: syncDesired('desired').notNull(),
    posState: posState('pos_state').notNull().default('none'),
    posOrderId: text('pos_order_id'),
    status: syncStatus('status').notNull().default('pending'),
    /** Temporary failures only; a 429 is not counted. */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The claim query only ever looks at rows that still have work to do.
    index('pos_sync_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'retrying')`),
  ],
);

/** One row per restaurant, locked to serialise rate-limit decisions for that restaurant only. */
export const posRateLimit = pgTable('pos_rate_limit', {
  restaurantId: text('restaurant_id').primaryKey(),
});

/** One row per POS request we sent, for the sliding-window rate limit. */
export const posRequestLog = pgTable(
  'pos_request_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    restaurantId: text('restaurant_id').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('pos_request_log_restaurant_sent_idx').on(table.restaurantId, table.sentAt)],
);

export type Check = typeof checks.$inferSelect;
export type PosSync = typeof posSync.$inferSelect;
