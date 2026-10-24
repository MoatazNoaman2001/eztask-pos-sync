import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { CreateOrderDto, ListOrdersQuery } from './orders.dto';
import { PosOrder } from './order.types';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto): Promise<{ posOrderId: string }> {
    return this.orders.create(dto);
  }

  @Get()
  findByExternalRef(@Query() query: ListOrdersQuery): Promise<PosOrder[]> {
    return this.orders.findByExternalRef(query);
  }

  @Post(':posOrderId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('posOrderId') posOrderId: string): Promise<PosOrder> {
    return this.orders.cancel(posOrderId);
  }
}
