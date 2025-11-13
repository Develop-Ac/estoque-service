import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class CreateLogDto {
  @ApiProperty({
    description: 'ID da contagem',
    example: 'clx1234567890abcdef'
  })
  @IsString()
  @IsNotEmpty()
  contagem_id!: string;

  @ApiProperty({
    description: 'ID do usuário',
    example: 'clx0987654321fedcba'
  })
  @IsString()
  @IsNotEmpty()
  usuario_id!: string;

  @ApiProperty({
    description: 'ID do item',
    example: 'clx1111222233334444'
  })
  @IsString()
  @IsNotEmpty()
  item_id!: string;

  @ApiProperty({
    description: 'Quantidade em estoque no sistema',
    example: 100
  })
  @IsNumber()
  estoque!: number;

  @ApiProperty({
    description: 'Quantidade contada fisicamente',
    example: 95
  })
  @IsNumber()
  contado!: number;
}