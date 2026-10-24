export interface PosOrder {
  posOrderId: string;
  externalRef: string;
  restaurantId: string;
  status: 'open' | 'cancelled';
}

export interface CreatePosOrder {
  externalRef: string;
  restaurantId: string;
  items: unknown[];
  total: number;
}

/**
 * Every POS call ends in exactly one of these. The worker reacts to the kind, never to raw HTTP.
 * - ok           2xx
 * - rate_limited 429: wait for the window, not a failure
 * - rejected     422 / other 4xx: permanent, stop and show the reason
 * - failed       5xx, timeout, network error: temporary, retry. For a create this may mean
 *                "created but we never heard back", so the worker must look it up before retrying.
 */
export type PosResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'failed'; message: string };
