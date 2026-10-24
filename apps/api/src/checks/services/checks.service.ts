import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Check } from '../../db/schema';
import { TransactionRunner } from '../../db/transaction';
import { PosSyncRepository } from '../../sync/repositories/pos-sync.repository';
import { CreateCheckDto } from '../dto/create-check.dto';
import { ChecksRepository } from '../repositories/checks.repository';

/**
 * Check lifecycle: open → paid → cancelled, or open → cancelled. Rules: docs/api.md
 *
 * These endpoints never call the POS (CLAUDE.md rule 1). They only record what happened and
 * what we want the POS to hold; the sync worker does the delivery. That keeps /pay fast and
 * working while the POS is down (spec guarantee 1).
 */
@Injectable()
export class ChecksService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly checks: ChecksRepository,
    private readonly posSync: PosSyncRepository,
  ) {}

  create(dto: CreateCheckDto): Promise<Check> {
    return this.checks.create({ restaurantId: dto.restaurantId, items: dto.items, total: dto.total });
  }

  async findById(id: string): Promise<Check> {
    const check = await this.checks.findById(id);
    if (!check) throw new NotFoundException(`Check ${id} not found`);
    return check;
  }

  pay(id: string): Promise<Check> {
    return this.transactions.run(async (tx) => {
      const check = await this.checks.findByIdForUpdate(id, tx);
      if (!check) throw new NotFoundException(`Check ${id} not found`);

      if (check.status === 'paid') return check; // paying twice is a harmless no-op
      if (check.status === 'cancelled') throw new ConflictException(`Check ${id} is cancelled and cannot be paid`);

      // Same transaction: a paid check always has its outbox row (CLAUDE.md rule 2).
      const paid = await this.checks.updateStatus(id, 'paid', tx);
      await this.posSync.createForPaidCheck(paid, tx);
      return paid;
    });
  }

  cancel(id: string): Promise<Check> {
    return this.transactions.run(async (tx) => {
      const check = await this.checks.findByIdForUpdate(id, tx);
      if (!check) throw new NotFoundException(`Check ${id} not found`);

      if (check.status === 'cancelled') return check; // cancelling twice is a harmless no-op

      const cancelled = await this.checks.updateStatus(id, 'cancelled', tx);
      // An open check was never paid, so it has no outbox row and the POS never hears of it.
      if (check.status === 'paid') {
        await this.posSync.requestCancellation(id, tx);
      }
      return cancelled;
    });
  }
}
