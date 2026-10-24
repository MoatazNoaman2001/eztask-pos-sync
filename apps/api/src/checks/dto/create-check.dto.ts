import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsNumber, IsString, Min, ValidateNested } from 'class-validator';

export class CheckItemDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

export class CreateCheckDto {
  @IsString()
  @IsNotEmpty()
  restaurantId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckItemDto)
  items!: CheckItemDto[];

  // Deliberately no @Min: a total <= 0 must be storable so the POS can reject it with 422
  // and we can show that rejection (spec guarantee 5). See docs/api.md.
  @IsNumber()
  total!: number;
}
