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

export class ListOrdersQuery {
  @IsString()
  @IsNotEmpty()
  externalRef!: string;

  // Not in the spec's contract: we require it so lookups count toward the restaurant's
  // rate limit like every other request (docs/discussion.md §4.2).
  @IsString()
  @IsNotEmpty()
  restaurantId!: string;
}
