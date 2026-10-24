import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

// Kept apart from database.module.ts so providers can import the tokens
// without a circular import (which would make them `undefined` at decoration time).
export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

export type Database = NodePgDatabase<typeof schema>;
