import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

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

  @ApiProperty({
    description: 'Identificador de agrupamento do item (compartilhado entre localizações do mesmo produto/dia)',
    example: '23251-2025-11-04',
    required: false
  })
  @IsString()
  @IsOptional()
  identificador_item?: string;

  @ApiProperty({
    description:
      'Data/hora (ISO) do momento REAL da contagem no dispositivo. Usada para gravar o início da contagem (offline-first). Se omitida, o backend usa a hora do recebimento.',
    example: '2025-11-10T13:30:00.000Z',
    required: false
  })
  @IsString()
  @IsOptional()
  client_time?: string;
}