import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';

export class CreateContagemItemDto {
  @ApiProperty({
    description: 'Data do item',
    example: '2025-11-04T00:00:00.000Z'
  })
  @IsDateString()
  DATA!: string;

  @ApiProperty({
    description: 'Código do produto',
    example: 23251
  })
  @IsNumber()
  COD_PRODUTO!: number;

  @ApiProperty({
    description: 'Descrição do produto',
    example: 'CAPA P/CHOQUE DIANT. S-10 12/16 PRETO LISO - DTS'
  })
  @IsString()
  @IsNotEmpty()
  DESC_PRODUTO!: string;

  @ApiProperty({
    description: 'Descrição da marca',
    example: 'DTS',
    required: false
  })
  @IsOptional()
  @IsString()
  MAR_DESCRICAO?: string;

  @ApiProperty({
    description: 'Referência do fabricante',
    example: null,
    required: false
  })
  @IsOptional()
  @IsString()
  REF_FABRICANTE?: string | null;

  @ApiProperty({
    description: 'Referência do fornecedor',
    example: '056597',
    required: false
  })
  @IsOptional()
  @IsString()
  REF_FORNECEDOR?: string;

  @ApiProperty({
    description: 'Localização do produto',
    example: 'B1002A03',
    required: false
  })
  @IsOptional()
  @IsString()
  LOCALIZACAO?: string;

  @ApiProperty({
    description: 'Unidade do produto',
    example: 'UN',
    required: false
  })
  @IsOptional()
  @IsString()
  UNIDADE?: string;

  @ApiProperty({
    description: 'Aplicações do produto',
    example: 'APLICAÇÃO ESPECÍFICA DO PRODUTO',
    required: false
  })
  @IsOptional()
  @IsString()
  APLICACOES?: string;

  @ApiProperty({
    description: 'Quantidade de saída',
    example: 1
  })
  @IsNumber()
  QTDE_SAIDA!: number;

  @ApiProperty({
    description: 'Quantidade em estoque',
    example: 8
  })
  @IsNumber()
  ESTOQUE!: number;

  @ApiProperty({
    description: 'Quantidade reservada',
    example: 2
  })
  @IsNumber()
  RESERVA!: number;
}

export class CreateContagemDto {
  @ApiProperty({
    description: 'Nome do colaborador que realizou a contagem',
    example: 'DIOGO DA SILVA SANTOS'
  })
  @IsString()
  @IsNotEmpty()
  colaborador!: string;

  @ApiProperty({
    description: 'Tipo da contagem (1, 2 ou 3)',
    example: 1,
    enum: [1, 2, 3]
  })
  @IsNumber()
  @IsNotEmpty()
  contagem!: number;

  @ApiProperty({
    description: 'Identificador comum para agrupar as 3 contagens (se não informado, será gerado automaticamente)',
    example: 'clx1234567890group',
    required: false
  })
  @IsOptional()
  @IsString()
  contagem_cuid?: string;

  @ApiProperty({
    description: 'Lista de produtos da contagem',
    type: [CreateContagemItemDto]
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateContagemItemDto)
  produtos!: CreateContagemItemDto[];

  piso?: string;

  @ApiProperty({
    description: 'Tipo de contagem estendida (1=Diária, 2=Avulsa)',
    example: 1,
    default: 1
  })
  @IsOptional()
  @IsNumber()
  tipo?: number;
}