import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Migration fixtures before 0055 must insert the columns that existed then.
 * Drizzle includes every declared column in INSERT, even when its value is default. */
export const legacySessions = pgTable('player_sessions', {
	serverId: text('server_id').notNull(),
	steamId: text('steam_id').notNull(),
	name: text('name').notNull(),
	faction: text('faction'),
	joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
	lastSeen: timestamp('last_seen', { withTimezone: true }).notNull(),
	leftAt: timestamp('left_at', { withTimezone: true }),
	kills: integer('kills').notNull().default(0),
	deaths: integer('deaths').notNull().default(0),
	cash: integer('cash').notNull().default(0),
	seedSeconds: integer('seed_seconds').notNull().default(0)
});
