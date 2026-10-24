import {
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChaosService } from '../../chaos/chaos.service';
import { SlidingWindowLimiter } from '../../rate-limit/sliding-window.limiter';
import { CreateOrderDto } from '../dto/create-order.dto';
import { ListOrdersQuery } from '../dto/list-orders.query';
import { PosOrder } from '../types/pos-order';
import { OrdersRepository } from '../repositories/orders.repository';

/**
 * Behaves like the third-party POS in the spec, including its bad habits:
 * not idempotent, rate-limited per restaurant, and randomly failing, slow or hanging.
 *
 * Every endpoint runs the same pipeline: rate limit → random 500 → (rules) → random slowness.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly repository: OrdersRepository,
    private readonly limiter: SlidingWindowLimiter,
    private readonly chaos: ChaosService,
  ) {}

  async create(dto: CreateOrderDto): Promise<{ posOrderId: string }> {
    this.enforceRateLimit(dto.restaurantId);
    this.maybeFail('create', dto.externalRef);

    if (dto.total <= 0) {
      this.logger.warn(`422 create ${dto.externalRef}: total ${dto.total} <= 0`);
      throw new UnprocessableEntityException(`total must be greater than 0, got ${dto.total}`);
    }

    await this.chaos.maybeBeSlow();

    // No check for an existing externalRef: real POS systems often aren't idempotent,
    // so sending the same check twice must create two orders.
    const order: PosOrder = {
      posOrderId: randomUUID(),
      externalRef: dto.externalRef,
      restaurantId: dto.restaurantId,
      items: dto.items,
      total: dto.total,
      status: 'open',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };
    this.repository.save(order);

    // The nasty case: the order exists, but the caller times out before hearing about it.
    if (this.chaos.shouldHangAfterCreate()) {
      this.logger.warn(`created ${order.posOrderId} for ${dto.externalRef}, hanging before answering`);
      await this.chaos.hangAfterCreate();
    }

    this.logger.log(`created ${order.posOrderId} for ${dto.externalRef}`);
    return { posOrderId: order.posOrderId };
  }

  async findByExternalRef(query: ListOrdersQuery): Promise<PosOrder[]> {
    this.enforceRateLimit(query.restaurantId);
    this.maybeFail('lookup', query.externalRef);
    await this.chaos.maybeBeSlow();
    return this.repository.findByExternalRef(query.externalRef);
  }

  async cancel(posOrderId: string): Promise<PosOrder> {
    // Look the order up first: cancel requests carry no restaurantId, the order does.
    const order = this.repository.findById(posOrderId);
    if (!order) throw new NotFoundException(`POS order ${posOrderId} not found`);

    this.enforceRateLimit(order.restaurantId);
    this.maybeFail('cancel', order.externalRef);
    await this.chaos.maybeBeSlow();

    // Cancelling twice is harmless, so a caller that timed out on a cancel can safely repeat it.
    if (order.status === 'open') {
      order.status = 'cancelled';
      order.cancelledAt = new Date().toISOString();
      this.logger.log(`cancelled ${posOrderId} for ${order.externalRef}`);
    }
    return order;
  }

  private enforceRateLimit(restaurantId: string): void {
    if (!this.limiter.tryAcquire(restaurantId)) {
      this.logger.warn(`429 for restaurant ${restaurantId}`);
      throw new HttpException('Too many requests for this restaurant', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private maybeFail(action: string, externalRef: string): void {
    if (this.chaos.shouldFail()) {
      this.logger.warn(`random 500 on ${action} ${externalRef}`);
      throw new InternalServerErrorException('Random POS failure (FAIL_RATE)');
    }
  }
}
