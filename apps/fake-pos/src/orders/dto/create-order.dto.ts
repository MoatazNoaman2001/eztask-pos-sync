import { IsArray, IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  externalRef!: string;

  @IsString()
  @IsNotEmpty()
  restaurantId!: string;

  @IsArray()
  items!: unknown[];

  // Any number is accepted here; total <= 0 is rejected later as a business rule (422).
  @IsNumber()
  total!: number;
}
