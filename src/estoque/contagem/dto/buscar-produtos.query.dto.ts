import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsInt, IsBoolean, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Filtros da CONTAGEM AVULSA: o usuário escolhe quais produtos contar a partir do
 * cadastro (grupo/subgrupo/marca/descrição/código), sem depender de movimentação.
 * Ao menos um filtro é obrigatório (validado na camada de negócio).
 */
export class BuscarProdutosQueryDto {
  @ApiProperty({ description: 'Código da empresa', example: '3', default: '3', required: false })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? '3' : String(value)))
  @Matches(/^\d+$/, { message: 'empresa deve conter apenas dígitos' })
  empresa?: string = '3';

  @ApiProperty({ description: 'Código do produto (exato)', example: 23251, required: false })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  cod_produto?: number;

  @ApiProperty({ description: 'Código da marca (MAR_CODIGO)', example: 12, required: false })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  marca?: number;

  @ApiProperty({ description: 'Descrição do produto (busca parcial)', example: 'CAPA', required: false })
  @IsOptional()
  @IsString()
  descricao?: string;

  @ApiProperty({ description: 'Código do grupo (GRP_CODIGO)', example: 1, required: false })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  grupo?: number;

  @ApiProperty({ description: 'Código do subgrupo (SUBGRP_CODIGO)', example: 3, required: false })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  subgrupo?: number;

  @ApiProperty({
    description: 'Quando true, retorna apenas produtos com saldo (disponível + reservado > 0)',
    example: true,
    default: true,
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return true;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true' || String(value) === '1';
  })
  @IsBoolean()
  somente_com_saldo?: boolean = true;

  @ApiProperty({
    description:
      'Recorte por piso/locação aplicado sobre as linhas explodidas (uma por locação). ' +
      'Valores: PISO_A, PISO_B, PISO_C, BOX, A-BOQUETA, A-CX ESCADA, VITRINE, VM, VENDA CASADA.',
    example: 'PISO_A',
    required: false,
  })
  @IsOptional()
  @IsString()
  piso?: string;
}
