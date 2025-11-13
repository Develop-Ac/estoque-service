import { ApiProperty } from '@nestjs/swagger';

export class ContagemResponseDto {
  @ApiProperty({
    description: 'ID único da contagem',
    example: 'clx1234567890abcdef'
  })
  id!: string;

  @ApiProperty({
    description: 'ID do colaborador que realizou a contagem',
    example: 'clx0987654321fedcba'
  })
  colaborador!: string;

  @ApiProperty({
    description: 'Tipo da contagem (1, 2 ou 3)',
    example: 1,
    enum: [1, 2, 3]
  })
  contagem!: number;
  
  @ApiProperty({
    description: 'Identificador comum para agrupar as 3 contagens criadas simultaneamente',
    example: 'clx1234567890group',
    nullable: true
  })
  contagem_cuid!: string | null;

  @ApiProperty({
    description: 'Indica se a contagem está liberada (true quando contagem = 1, false para demais valores)',
    example: true
  })
  liberado_contagem!: boolean;

  @ApiProperty({
    description: 'Data de criação da contagem',
    example: '2025-11-04T14:30:00.000Z'
  })
  created_at!: Date;

  @ApiProperty({
    description: 'Dados do usuário que realizou a contagem',
    example: {
      id: 'clx0987654321fedcba',
      nome: 'DIOGO DA SILVA SANTOS',
      codigo: 'DS001'
    }
  })
  usuario!: {
    id: string;
    nome: string;
    codigo: string;
  };

  @ApiProperty({
    description: 'Lista de itens da contagem (presente apenas em alguns endpoints)',
    example: [
      {
        id: 'clx1111222233334444',
        contagem_cuid: 'clx1234567890group',
        data: '2025-11-04T00:00:00.000Z',
        cod_produto: 23251,
        desc_produto: 'CAPA P/CHOQUE DIANT. S-10 12/16 PRETO LISO - DTS',
        mar_descricao: 'DTS',
        ref_fabricante: null,
        ref_fornecedor: '056597',
        localizacao: 'B1002A03',
        unidade: 'UN',
        aplicacoes: 'APLICAÇÃO ESPECÍFICA DO PRODUTO',
        qtde_saida: 1,
        estoque: 8,
        reserva: 2,
        conferir: true
      }
    ],
    required: false
  })
  itens?: Array<{
    id: string;
    contagem_cuid: string;
    data: Date;
    cod_produto: number;
    desc_produto: string;
    mar_descricao: string | null;
    ref_fabricante: string | null;
    ref_fornecedor: string | null;
    localizacao: string | null;
    unidade: string | null;
    aplicacoes: string | null;
    qtde_saida: number;
    estoque: number;
    reserva: number;
    conferir: boolean;
  }>;

  @ApiProperty({
    description: 'Lista de logs da contagem',
    example: [
      {
        id: 'clx5555666677778888',
        contagem_id: 'clx1234567890abcdef',
        usuario_id: 'clx0987654321fedcba',
        item_id: 'clx1111222233334444',
        estoque: 100,
        contado: 95,
        created_at: '2025-11-10T13:30:00.000Z'
      }
    ],
    required: false
  })
  logs?: Array<{
    id: string;
    contagem_id: string;
    usuario_id: string;
    item_id: string;
    estoque: number;
    contado: number;
    created_at: Date;
  }>;
}