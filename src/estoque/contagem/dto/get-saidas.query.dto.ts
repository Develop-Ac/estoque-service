import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

export class GetSaidasQueryDto {
  @ApiProperty({
    description: 'Data inicial para consulta das saídas do estoque (formato: YYYY-MM-DD)',
    example: '2024-01-01',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    required: true
  })
  @IsString()
  @Matches(DATE_RX, { message: 'data_inicial deve ser YYYY-MM-DD' })
  data_inicial!: string;

  @ApiProperty({
    description: 'Data final para consulta das saídas do estoque (formato: YYYY-MM-DD)',
    example: '2024-01-31',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    required: true
  })
  @IsString()
  @Matches(DATE_RX, { message: 'data_final deve ser YYYY-MM-DD' })
  data_final!: string;

  @ApiProperty({
    description: 'Código da empresa',
    example: '3',
    default: '3',
    required: false
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? '3' : String(value)))
  @Matches(/^\d+$/, { message: 'empresa deve conter apenas dígitos' })
  empresa?: string = '3';
  @ApiProperty({
    description: 'Tipo de contagem (1=Diária, 2=Avulsa)',
    example: 1,
    required: false
  })
  @IsOptional()
  @Transform(({ value }) => (value ? Number(value) : 1))
  @IsNumber()
  tipo?: number = 1;
}
