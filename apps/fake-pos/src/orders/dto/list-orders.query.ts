import { IsNotEmpty, IsString } from 'class-validator';

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
