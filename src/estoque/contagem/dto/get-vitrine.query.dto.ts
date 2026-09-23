import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

export class GetVitrineQueryDto {
  @ApiProperty({
    description: 'Dia das saídas (YYYY-MM-DD). Sem informar, usa ONTEM (fuso America/Sao_Paulo).',
    example: '2026-09-22',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(DATE_RX, { message: 'data deve ser YYYY-MM-DD' })
  data?: string;

  @ApiProperty({ description: 'Código da empresa', example: '3', default: '3', required: false })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'empresa deve conter apenas dígitos' })
  empresa?: string;
}
