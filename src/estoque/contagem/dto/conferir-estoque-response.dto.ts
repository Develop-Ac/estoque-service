import { ApiProperty } from '@nestjs/swagger';

export class ConferirEstoqueResponseDto {
  @ApiProperty({
    description: 'Código do produto',
    example: 23251
  })
  pro_codigo!: number;

  @ApiProperty({
    description: 'Estoque disponível do produto',
    example: 15
  })
  ESTOQUE!: number;
}