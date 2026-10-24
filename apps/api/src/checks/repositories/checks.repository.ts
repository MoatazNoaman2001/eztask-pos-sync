import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Database, DB } from '../../db/db.tokens';
import { Check, CheckItem, checks } from '../../db/schema';
import { DbExecutor } from '../../db/transaction';

export interface NewCheck {
  restaurantId: string;
  items: CheckItem[];
  total: number;
}

@Injectable()
export class ChecksRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: NewCheck, tx: DbExecutor = this.db): Promise<Check> {
    const [check] = await tx.insert(checks).values(input).returning();
    if (!check) throw new Error('Insert into checks returned no row');
    return check;
  }

  async findById(id: string, tx: DbExecutor = this.db): Promise<Check | undefined> {
    const [check] = await tx.select().from(checks).where(eq(checks.id, id));
    return check;
  }

  /**
   * SELECT … FOR UPDATE: holds the row until the transaction ends, so a concurrent
   * /pay and /cancel on the same check run one after the other, never interleaved.
   */
  async findByIdForUpdate(id: string, tx: DbExecutor): Promise<Check | undefined> {
    const [check] = await tx.select().from(checks).where(eq(checks.id, id)).for('update');
    return check;
  }

  async updateStatus(id: string, status: Check['status'], tx: DbExecutor): Promise<Check> {
    const [check] = await tx
      .update(checks)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(checks.id, id))
      .returning();
    if (!check) throw new Error(`Check ${id} disappeared during update`);
    return check;
  }
}
