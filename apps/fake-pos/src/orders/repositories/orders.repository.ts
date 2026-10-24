import { Injectable } from '@nestjs/common';
import { PosOrder } from '../types/pos-order';

// In memory on purpose: the fake POS runs as one instance and the chaos test never kills it.
@Injectable()
export class OrdersRepository {
  private readonly orders = new Map<string, PosOrder>();

  save(order: PosOrder): void {
    this.orders.set(order.posOrderId, order);
  }

  findById(posOrderId: string): PosOrder | undefined {
    return this.orders.get(posOrderId);
  }

  findByExternalRef(externalRef: string): PosOrder[] {
    return this.all().filter((order) => order.externalRef === externalRef);
  }

  all(): PosOrder[] {
    return [...this.orders.values()];
  }

  clear(): void {
    this.orders.clear();
  }
}
