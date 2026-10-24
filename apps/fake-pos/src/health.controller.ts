import { Controller, Get } from '@nestjs/common';

// Used by docker compose healthchecks and the chaos test to know when an instance is up.
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
