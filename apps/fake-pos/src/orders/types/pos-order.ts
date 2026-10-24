export type PosOrderStatus = 'open' | 'cancelled';

export interface PosOrder {
  posOrderId: string;
  externalRef: string;
  restaurantId: string;
  items: unknown[];
  total: number;
  status: PosOrderStatus;
  createdAt: string;
  cancelledAt: string | null;
}
