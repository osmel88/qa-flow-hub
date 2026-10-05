import { Controller, Get, Header, Res, VERSION_NEUTRAL } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { ReadinessReport, ReadinessService } from './readiness.service';

@ApiTags('health')
// Version neutral and outside the global prefix: probes are infrastructure, not
// part of the versioned public API, and their URL must never change.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly readiness: ReadinessService) {}

  /**
   * Liveness: is the process running? Container orchestrators restart the
   * container when this fails, so it must never touch the database — a slow
   * query would trigger a restart loop.
   */
  @Public()
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'The process is running.' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) };
  }

  /**
   * Readiness: should this instance receive traffic? 503 while a dependency
   * is down, a migration is missing or the process is draining after SIGTERM.
   */
  @Public()
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiOkResponse({ description: 'Every dependency answered.' })
  @ApiServiceUnavailableResponse({ description: 'Not ready, or draining before shutdown.' })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    void reply.status(report.status === 'ready' ? 200 : 503);
    return report;
  }
}
