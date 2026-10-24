import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Check } from '../../db/schema';
import { CreateCheckDto } from '../dto/create-check.dto';
import { ChecksService } from '../services/checks.service';

@Controller('checks')
export class ChecksController {
  constructor(private readonly checks: ChecksService) {}

  @Post()
  create(@Body() dto: CreateCheckDto): Promise<Check> {
    return this.checks.create(dto);
  }

  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  pay(@Param('id', ParseUUIDPipe) id: string): Promise<Check> {
    return this.checks.pay(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<Check> {
    return this.checks.cancel(id);
  }
}
