import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { Database, DB } from '../../db/db.tokens';
import { posRateLimit, posRequestLog } from '../../db/schema';

export type TokenResult = { acquired: true } | { acquired: false; retryInMs: number };

/**
 * Sliding-window limit per restaurant, shared by every API instance through Postgres
 * (docs/rate-limiting.md). All times are Postgres now(), so instance clocks don't matter.
 */
@Injectable()
export class RateLimitRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  tryAcquire(restaurantId: string, maxRequests: number, windowMs: number): Promise<TokenResult> {
    // clock_timestamp(), not now(): now() is when the transaction *started*. A caller that waited
    // on the restaurant lock would log its request too early and let the window expire too soon.
    const currentTime = sql`clock_timestamp()`;
    // Parenthesised on purpose: this fragment is embedded in `min(sent_at) - ${windowStart}`, and
    // without the brackets SQL reads it as `min(sent_at) - clock_timestamp() - 10s` (see AI_NOTES.md).
    const windowStart = sql`(${currentTime} - (${windowMs}::int * interval '1 millisecond'))`;

    return this.db.transaction(async (tx) => {
      // Lock this restaurant's row: decisions for one restaurant run one at a time,
      // while other restaurants are never blocked (spec guarantee 4).
      await tx.insert(posRateLimit).values({ restaurantId }).onConflictDoNothing();
      await tx.select().from(posRateLimit).where(eq(posRateLimit.restaurantId, restaurantId)).for('update');

      // Forget requests that have left the window; whatever remains is inside it.
      await tx
        .delete(posRequestLog)
        .where(and(eq(posRequestLog.restaurantId, restaurantId), lte(posRequestLog.sentAt, windowStart)));

      const [usage] = await tx
        .select({
          sent: sql<number>`count(*)::int`,
          // When the oldest request in the window expires, a slot frees up.
          freesInMs: sql<number | null>`ceil(extract(epoch from (min(${posRequestLog.sentAt}) - ${windowStart})) * 1000)::int`,
        })
        .from(posRequestLog)
        .where(eq(posRequestLog.restaurantId, restaurantId));

      if (!usage || usage.sent < maxRequests) {
        await tx.insert(posRequestLog).values({ restaurantId, sentAt: currentTime });
        return { acquired: true };
      }
      return { acquired: false, retryInMs: Math.max(1, usage.freesInMs ?? windowMs) };
    });
  }
}
