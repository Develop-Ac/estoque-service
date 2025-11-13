import { ApiProperty } from '@nestjs/swagger';

export class UpdateConferirDto {
  @ApiProperty({
    description: 'Define se o item foi conferido',
    example: true,
    type: 'boolean'
  })
  conferir!: boolean;
}
