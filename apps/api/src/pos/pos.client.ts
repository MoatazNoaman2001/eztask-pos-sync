import { Inject, Injectable } from '@nestjs/common';
import { API_CONFIG, ApiConfig } from '../config/api.config';
import { CreatePosOrder, PosOrder, PosResult } from './pos.types';

/** HTTP client for the restaurant POS. Turns every response, timeout or error into a PosResult. */
@Injectable()
export class PosClient {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  createOrder(order: CreatePosOrder): Promise<PosResult<{ posOrderId: string }>> {
    return this.request('POST', '/orders', order);
  }

  findOrders(externalRef: string, restaurantId: string): Promise<PosResult<PosOrder[]>> {
    const query = new URLSearchParams({ externalRef, restaurantId });
    return this.request('GET', `/orders?${query.toString()}`);
  }

  cancelOrder(posOrderId: string): Promise<PosResult<PosOrder>> {
    return this.request('POST', `/orders/${encodeURIComponent(posOrderId)}/cancel`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PosResult<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.config.posBaseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Must stay below the worker lease (checked at startup), see docs/pos-integration.md.
        signal: AbortSignal.timeout(this.config.posHttpTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        kind: 'failed',
        message: timedOut ? `POS timeout after ${this.config.posHttpTimeoutMs}ms` : `POS unreachable: ${describe(error)}`,
      };
    }

    if (response.ok) return { kind: 'ok', value: (await response.json()) as T };

    const message = `POS ${response.status}: ${await errorMessage(response)}`;
    if (response.status === 429) return { kind: 'rate_limited', message };
    if (response.status >= 400 && response.status < 500) return { kind: 'rejected', message };
    return { kind: 'failed', message };
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? error.cause.message : error.message;
  return String(error);
}
