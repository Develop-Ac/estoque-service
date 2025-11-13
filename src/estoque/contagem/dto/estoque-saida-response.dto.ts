import { ApiProperty } from '@nestjs/swagger';

export class EstoqueSaidaResponseDto {
  @ApiProperty({
    description: 'Data da movimentação do estoque',
    example: '2024-01-15',
    type: 'string',
    format: 'date'
  })
  data!: string;

  @ApiProperty({
    description: 'Código do produto',
    example: 12345,
    type: 'number'
  })
  COD_PRODUTO!: number;

  @ApiProperty({
    description: 'Descrição do produto',
    example: 'PRODUTO EXEMPLO ABC',
    type: 'string'
  })
  DESC_PRODUTO!: string;

  @ApiProperty({
    description: 'Descrição da marca',
    example: 'MARCA EXEMPLO',
    type: 'string'
  })
  mar_descricao!: string;

  @ApiProperty({
    description: 'Referência do fabricante',
    example: 'REF123456',
    type: 'string',
    nullable: true
  })
  ref_fabricante!: string | null;

  @ApiProperty({
    description: 'Referência do fornecedor',
    example: 'FORN789',
    type: 'string',
    nullable: true
  })
  ref_FORNECEDOR!: string | null;

  @ApiProperty({
    description: 'Localização do produto no estoque',
    example: 'A01-B02',
    type: 'string',
    nullable: true
  })
  LOCALIZACAO!: string | null;

  @ApiProperty({
    description: 'Unidade de medida',
    example: 'UN',
    type: 'string',
    nullable: true
  })
  unidade!: string | null;

  @ApiProperty({
    description: 'Aplicações do produto',
    example: 'APLICAÇÃO ESPECÍFICA DO PRODUTO',
    type: 'string',
    nullable: true
  })
  APLICACOES!: string | null;

  @ApiProperty({
    description: 'Código de barras do produto',
    example: '7891234567890',
    type: 'string',
    nullable: true
  })
  codigo_barras!: string | null;

  @ApiProperty({
    description: 'Quantidade de saída do produto',
    example: 5,
    type: 'number'
  })
  QTDE_SAIDA!: number;

  @ApiProperty({
    description: 'Estoque disponível atual',
    example: 100,
    type: 'number',
    nullable: true
  })
  ESTOQUE!: number | null;

  @ApiProperty({
    description: 'Estoque reservado',
    example: 10,
    type: 'number',
    nullable: true
  })
  RESERVA!: number | null;
}