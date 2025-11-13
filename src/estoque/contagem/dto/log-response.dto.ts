import { ApiProperty } from '@nestjs/swagger';

export class LogResponseDto {
  @ApiProperty({
    description: 'ID único do log',
    example: 'clx5555666677778888'
  })
  id!: string;

  @ApiProperty({
    description: 'ID da contagem',
    example: 'clx1234567890abcdef'
  })
  contagem_id!: string;

  @ApiProperty({
    description: 'ID do usuário',
    example: 'clx0987654321fedcba'
  })
  usuario_id!: string;

  @ApiProperty({
    description: 'ID do item',
    example: 'clx1111222233334444'
  })
  item_id!: string;

  @ApiProperty({
    description: 'Quantidade em estoque no sistema',
    example: 100
  })
  estoque!: number;

  @ApiProperty({
    description: 'Quantidade contada fisicamente',
    example: 95
  })
  contado!: number;

  @ApiProperty({
    description: 'Data de criação do log',
    example: '2025-11-10T13:30:00.000Z'
  })
  created_at!: Date;
}