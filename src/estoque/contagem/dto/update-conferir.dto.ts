import { ApiProperty } from '@nestjs/swagger';

export class UpdateConferirDto {
  @ApiProperty({
    description: 'Define se o item foi conferido',
    example: true,
    type: 'boolean'
  })
  conferir!: boolean;
  @ApiProperty({
    description: 'Identificador único do item',
    example: 'abc123',
    type: 'string'
  })
  itemId!: string;
}
