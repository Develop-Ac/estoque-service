import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EstoqueSaidasRepository } from './contagem.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { OpenQueryService } from '../../shared/database/openquery/openquery.service';
import { CreateContagemDto } from './dto/create-contagem.dto';

// Mock do crypto.randomUUID
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: () => 'mocked-uuid-12345',
  },
});

describe('EstoqueSaidasRepository', () => {
  let repository: EstoqueSaidasRepository;
  let prismaService: jest.Mocked<PrismaService>;
  let openQueryService: jest.Mocked<OpenQueryService>;

  const mockPrismaService = {
    sis_usuarios: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    est_contagem: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    est_contagem_itens: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    est_contagem_log: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockOpenQueryService = {
    query: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EstoqueSaidasRepository,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: OpenQueryService,
          useValue: mockOpenQueryService,
        },
      ],
    }).compile();

    repository = module.get<EstoqueSaidasRepository>(EstoqueSaidasRepository);
    prismaService = module.get<PrismaService>(PrismaService) as jest.Mocked<PrismaService>;
    openQueryService = module.get<OpenQueryService>(OpenQueryService) as jest.Mocked<OpenQueryService>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('fetchSaidas', () => {
    it('deve buscar saídas do estoque via OpenQuery', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 12345,
          DESC_PRODUTO: 'PRODUTO EXEMPLO ABC',
          mar_descricao: 'MARCA EXEMPLO',
          ref_fabricante: 'REF123456',
          ref_FORNECEDOR: 'FORN789',
          LOCALIZACAO: 'A01-B02',
          unidade: 'UN',
          APLICACOES: null,
          codigo_barras: null,
          QTDE_SAIDA: 5,
          ESTOQUE: 100,
          RESERVA: 10,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      expect(openQueryService.query).toHaveBeenCalledWith(
        expect.stringContaining('OPENQUERY'),
        {},
        { timeout: 300_000 },
      );
      expect(result).toEqual(mockSaidas);
    });

    it('deve explodir um produto em N linhas, uma por localização distinta', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      // LOCALIZACAO com 2 códigos + APLICACOES com 1 código => 3 locações distintas.
      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 12345,
          DESC_PRODUTO: 'PRODUTO MULTILOCAL',
          mar_descricao: 'MARCA',
          ref_fabricante: 'REF1',
          ref_FORNECEDOR: 'FORN1',
          LOCALIZACAO: 'A1204E02 A1305B01',
          unidade: 'UN',
          APLICACOES: 'C1010D05',
          codigo_barras: null,
          QTDE_SAIDA: 5,
          ESTOQUE: 100,
          RESERVA: 10,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      expect(result).toHaveLength(3);
      const locs = result.map((r) => r.LOCALIZACAO);
      expect(locs).toEqual(
        expect.arrayContaining(['A1204E02', 'A1305B01', 'C1010D05']),
      );
      // Cada linha vira uma locação única, sem duplicatas, e APLICACOES é zerado.
      expect(new Set(locs).size).toBe(3);
      result.forEach((r) => expect(r.APLICACOES).toBeNull());
    });

    it('deve reconhecer locações de Vitrine Móvel (VM202A01 / VM0202A01)', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      // VM tem prefixo de 2 letras. Deve ser extraída da LOCALIZACAO (mesmo misturada
      // com um código padrão) e também das APLICACOES.
      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 999,
          DESC_PRODUTO: 'PRODUTO VITRINE MOVEL',
          mar_descricao: 'MARCA',
          ref_fabricante: 'REF1',
          ref_FORNECEDOR: 'FORN1',
          LOCALIZACAO: 'VM202A01 A1204E02',
          unidade: 'UN',
          APLICACOES: 'VM0202A01',
          codigo_barras: null,
          QTDE_SAIDA: 3,
          ESTOQUE: 20,
          RESERVA: 0,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      const locs = result.map((r) => r.LOCALIZACAO);
      expect(locs).toEqual(
        expect.arrayContaining(['VM202A01', 'A1204E02', 'VM0202A01']),
      );
      expect(new Set(locs).size).toBe(3);
    });

    it('deve deduplicar localizações repetidas entre LOCALIZACAO e APLICACOES', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 555,
          DESC_PRODUTO: 'PRODUTO REPETIDO',
          mar_descricao: 'MARCA',
          ref_fabricante: 'REF1',
          ref_FORNECEDOR: 'FORN1',
          LOCALIZACAO: 'A1204E02',
          unidade: 'UN',
          APLICACOES: 'A1204E02', // mesma locação => não deve duplicar
          codigo_barras: null,
          QTDE_SAIDA: 1,
          ESTOQUE: 10,
          RESERVA: 0,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      expect(result).toHaveLength(1);
      expect(result[0].LOCALIZACAO).toBe('A1204E02');
    });

    it('deve gerar exatamente uma linha quando a localização não é reconhecida', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 999,
          DESC_PRODUTO: 'PRODUTO SEM LOCAL',
          mar_descricao: 'MARCA',
          ref_fabricante: 'REF1',
          ref_FORNECEDOR: 'FORN1',
          LOCALIZACAO: 'VENDA CASADA', // não bate nas regras => mantém original
          unidade: 'UN',
          APLICACOES: 'HB20', // aplicação de veículo, não é locação => ignorado
          codigo_barras: null,
          QTDE_SAIDA: 2,
          ESTOQUE: 20,
          RESERVA: 0,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      expect(result).toHaveLength(1);
      expect(result[0].LOCALIZACAO).toBe('VENDA CASADA');
      expect(result[0].APLICACOES).toBeNull();
    });

    it('deve rejeitar com datas inválidas', async () => {
      const params = {
        data_inicial: 'data-invalida',
        data_final: '2024-01-31',
        empresa: '3',
      };

      await expect(repository.fetchSaidas(params)).rejects.toThrow('Datas devem ser YYYY-MM-DD');
    });

    it('deve rejeitar com empresa inválida', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: 'empresa-invalida',
      };

      await expect(repository.fetchSaidas(params)).rejects.toThrow('Empresa inválida');
    });

    it('deve manter LOCALIZACAO como BOX (não A-BOX) quando banco retorna "BOX 03"', async () => {
      const params = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      const mockSaidas = [
        {
          data: '2024-01-15',
          COD_PRODUTO: 99001,
          DESC_PRODUTO: 'PRODUTO BOX',
          mar_descricao: 'MARCA X',
          ref_fabricante: 'REFBOX',
          ref_FORNECEDOR: 'FORNBOX',
          LOCALIZACAO: 'BOX 03',
          unidade: 'UN',
          APLICACOES: null,
          codigo_barras: null,
          QTDE_SAIDA: 2,
          ESTOQUE: 10,
          RESERVA: 0,
        },
      ];

      openQueryService.query.mockResolvedValue(mockSaidas);

      const result = await repository.fetchSaidas(params);

      // LOCALIZACAO deve permanecer BOX 03, não virar A-BOX 03 (comportamento do Deploy)
      expect(result[0].LOCALIZACAO).toBe('BOX 03');
      expect(result[0].LOCALIZACAO).not.toMatch(/^A-BOX/);
    });
  });

  describe('createContagem', () => {
    it('deve criar uma nova contagem com itens', async () => {
      const createContagemDto: CreateContagemDto = {
        colaborador: 'JOÃO DA SILVA',
        contagem: 1,
        contagem_cuid: 'grupo-123',
        produtos: [
          {
            DATA: '2024-01-15',
            COD_PRODUTO: 12345,
            DESC_PRODUTO: 'PRODUTO TESTE',
            MAR_DESCRICAO: 'MARCA TESTE',
            REF_FABRICANTE: 'REF123',
            REF_FORNECEDOR: 'FORN123',
            LOCALIZACAO: 'A01-B02',
            UNIDADE: 'UN',
            QTDE_SAIDA: 5,
            ESTOQUE: 100,
            RESERVA: 10,
          },
        ],
      };

      const mockUsuario = {
        id: 'user-456',
        nome: 'JOÃO DA SILVA',
        codigo: 'JS001',
        setor: 'ESTOQUE',
        senha: 'hash123',
        trash: 0,
      };

      const mockContagem = {
        id: 'contagem-123',
        colaborador: 'user-456',
        contagem: 1,
        contagem_cuid: 'grupo-123',
        liberado_contagem: true,
        created_at: new Date('2024-01-15T10:00:00Z'),
        usuario: {
          id: 'user-456',
          nome: 'JOÃO DA SILVA',
          codigo: 'JS001',
        },
      };

      const mockItem = {
        id: 'item-789',
        contagem_cuid: 'grupo-123',
        data: new Date('2024-01-15T00:00:00Z'),
        cod_produto: 12345,
        desc_produto: 'PRODUTO TESTE',
        mar_descricao: 'MARCA TESTE',
        ref_fabricante: 'REF123',
        ref_fornecedor: 'FORN123',
        localizacao: 'A01-B02',
        unidade: 'UN',
        qtde_saida: 5,
        estoque: 100,
        reserva: 10,
        conferir: false,
      };

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue(mockUsuario);
      mockPrismaService.est_contagem_itens.findMany.mockResolvedValue([]);

      // Mock da transação
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const txMock = {
          est_contagem: {
            create: jest.fn().mockResolvedValue(mockContagem),
          },
          est_contagem_itens: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0), // slot livre p/ o identificador
            create: jest.fn().mockResolvedValue(mockItem),
          },
        } as any;
        return callback(txMock as any);
      });

      const result = await repository.createContagem(createContagemDto);

      expect(prismaService.sis_usuarios.findFirst).toHaveBeenCalledWith({
        where: {
          nome: 'JOÃO DA SILVA',
          trash: 0,
        },
      });
      expect(prismaService.$transaction).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 'contagem-123');
      expect(result).toHaveProperty('itens');
    });

    it('deve agrupar N localizações do mesmo produto/dia sob um único identificador_item', async () => {
      const createContagemDto: CreateContagemDto = {
        colaborador: 'JOÃO DA SILVA',
        contagem: 1,
        contagem_cuid: 'grupo-123',
        produtos: [
          // 3 localizações do MESMO produto/dia (já explodidas pelo fetchSaidas)
          { DATA: '2024-01-15', COD_PRODUTO: 12345, DESC_PRODUTO: 'P', MAR_DESCRICAO: 'M', REF_FABRICANTE: 'R', REF_FORNECEDOR: 'F', LOCALIZACAO: 'A1204E02', UNIDADE: 'UN', QTDE_SAIDA: 1, ESTOQUE: 30, RESERVA: 0 },
          { DATA: '2024-01-15', COD_PRODUTO: 12345, DESC_PRODUTO: 'P', MAR_DESCRICAO: 'M', REF_FABRICANTE: 'R', REF_FORNECEDOR: 'F', LOCALIZACAO: 'A1305B01', UNIDADE: 'UN', QTDE_SAIDA: 1, ESTOQUE: 30, RESERVA: 0 },
          { DATA: '2024-01-15', COD_PRODUTO: 12345, DESC_PRODUTO: 'P', MAR_DESCRICAO: 'M', REF_FABRICANTE: 'R', REF_FORNECEDOR: 'F', LOCALIZACAO: 'C1010D05', UNIDADE: 'UN', QTDE_SAIDA: 1, ESTOQUE: 30, RESERVA: 0 },
        ],
      };

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue({
        id: 'user-456', nome: 'JOÃO DA SILVA', codigo: 'JS001', setor: 'ESTOQUE', senha: 'h', trash: 0,
      });

      const createdItems: any[] = [];
      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const txMock = {
          est_contagem: {
            create: jest.fn().mockResolvedValue({ id: 'contagem-123', contagem_cuid: 'grupo-123', usuario: {} }),
          },
          est_contagem_itens: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0), // nenhuma sessão anterior
            create: jest.fn().mockImplementation(({ data }) => {
              createdItems.push(data);
              return Promise.resolve({ id: `item-${createdItems.length}`, ...data });
            }),
          },
        } as any;
        return callback(txMock as any);
      });

      await repository.createContagem(createContagemDto);

      // As 3 localizações foram criadas...
      expect(createdItems).toHaveLength(3);
      // ...todas com o MESMO identificador_item (base, sem versionar).
      const identificadores = new Set(createdItems.map((i) => i.identificador_item));
      expect(identificadores.size).toBe(1);
      expect([...identificadores][0]).toBe('12345-2024-01-15');
    });

    it('deve rejeitar se colaborador não encontrado', async () => {
      const createContagemDto: CreateContagemDto = {
        colaborador: 'USUÁRIO INEXISTENTE',
        contagem: 1,
        contagem_cuid: 'grupo-123',
        produtos: [],
      };

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue(null);

      await expect(repository.createContagem(createContagemDto)).rejects.toThrow(
        'Colaborador com nome "USUÁRIO INEXISTENTE" não encontrado',
      );
    });

    it('deve usar crypto.randomUUID se contagem_cuid não fornecido', async () => {
      const createContagemDto: CreateContagemDto = {
        colaborador: 'JOÃO DA SILVA',
        contagem: 1,
        produtos: [],
      };

      const mockUsuario = {
        id: 'user-456',
        nome: 'JOÃO DA SILVA',
        codigo: 'JS001',
        setor: 'ESTOQUE',
        senha: 'hash123',
        trash: 0,
      };

      const mockContagem = {
        id: 'contagem-123',
        colaborador: 'user-456',
        contagem: 1,
        contagem_cuid: 'mocked-uuid-12345',
        liberado_contagem: true,
        created_at: new Date('2024-01-15T10:00:00Z'),
        usuario: {
          id: 'user-456',
          nome: 'JOÃO DA SILVA',
          codigo: 'JS001',
        },
      };

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue(mockUsuario);

      mockPrismaService.$transaction.mockImplementation(async (callback) => {
        const txMock = {
          est_contagem: {
            create: jest.fn().mockResolvedValue(mockContagem),
          },
          est_contagem_itens: {
            findMany: jest.fn().mockResolvedValue([]),
          },
        } as any;
        return callback(txMock as any);
      });

      const result = await repository.createContagem(createContagemDto);

      expect(result.contagem_cuid).toBe('mocked-uuid-12345');
    });
  });

  describe('getContagensByUsuario', () => {
    it('deve retornar contagens do usuário com itens', async () => {
      const idUsuario = 'user-123';

      const mockUsuario = {
        id: 'user-123',
        nome: 'JOÃO DA SILVA',
        codigo: 'JS001',
        setor: 'ESTOQUE',
        senha: 'hash123',
        trash: 0,
      };

      const mockContagens = [
        {
          id: 'contagem-123',
          colaborador: 'user-123',
          contagem: 1,
          contagem_cuid: 'grupo-456',
          liberado_contagem: true,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: {
            id: 'user-123',
            nome: 'JOÃO DA SILVA',
            codigo: 'JS001',
          },
        },
      ];

      const mockItens = [
        {
          id: 'item-789',
          contagem_cuid: 'grupo-456',
          data: new Date('2024-01-15T00:00:00Z'),
          cod_produto: 12345,
          desc_produto: 'PRODUTO TESTE',
          mar_descricao: 'MARCA TESTE',
          ref_fabricante: 'REF123',
          ref_fornecedor: 'FORN123',
          localizacao: 'A01-B02',
          unidade: 'UN',
          qtde_saida: 5,
          estoque: 100,
          reserva: 10,
          conferir: false,
        },
      ];

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue(mockUsuario);
      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);
      mockPrismaService.est_contagem_itens.findMany.mockResolvedValue(mockItens);

      const result = await repository.getContagensByUsuario(idUsuario);

      expect(mockPrismaService.sis_usuarios.findFirst).toHaveBeenCalledWith({
        where: { id: idUsuario, trash: 0 },
      });
      expect(mockPrismaService.est_contagem.findMany).toHaveBeenCalledWith({
        where: { colaborador: idUsuario },
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              codigo: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('itens');
      expect(result[0].itens).toHaveLength(1);
    });

    it('deve rejeitar se usuário não encontrado', async () => {
      const idUsuario = 'user-inexistente';

      mockPrismaService.sis_usuarios.findFirst.mockResolvedValue(null);

      await expect(repository.getContagensByUsuario(idUsuario)).rejects.toThrow(
        'Usuário com ID "user-inexistente" não encontrado',
      );
    });
  });

  describe('updateItemConferir', () => {
    it('deve confiar no front e atualizar conferir quando o item ainda não tem logs', async () => {
      const identificador = '12345-2024-01-15';
      const itemId = 'item-123';
      const conferir = true;

      const mockItem = {
        id: 'item-123',
        identificador_item: identificador,
        contagem_cuid: 'grupo-456',
        cod_produto: 12345,
        desc_produto: 'PRODUTO TESTE',
        estoque: 100,
      };

      const mockUpdatedItem = { ...mockItem, conferir: true };

      // Sem logs => o método confia no valor do front e faz update simples.
      mockPrismaService.est_contagem_itens.findUnique.mockResolvedValue(mockItem);
      mockPrismaService.est_contagem_log.findMany.mockResolvedValue([]);
      mockPrismaService.est_contagem_itens.update.mockResolvedValue(mockUpdatedItem);

      const result = await repository.updateItemConferir(identificador, conferir, itemId);

      expect(mockPrismaService.est_contagem_itens.update).toHaveBeenCalledWith({
        where: { id: itemId },
        data: { conferir },
      });
      expect(result).toEqual(mockUpdatedItem);
    });

    it('deve lançar erro se o item de contagem não existir', async () => {
      mockPrismaService.est_contagem_itens.findUnique.mockResolvedValue(null);

      await expect(
        repository.updateItemConferir('id-x', true, 'item-inexistente'),
      ).rejects.toThrow('Item de contagem não encontrado');
    });
  });

  describe('getEstoqueProduto', () => {
    it('deve retornar estoque do produto via OpenQuery', async () => {
      const codProduto = 12345;
      const empresa = '3';

      const mockEstoque = [
        {
          pro_codigo: 12345,
          ESTOQUE: 15,
        },
      ];

      openQueryService.query.mockResolvedValue(mockEstoque);

      const result = await repository.getEstoqueProduto(codProduto, empresa);

      expect(openQueryService.query).toHaveBeenCalledWith(
        expect.stringContaining('OPENQUERY'),
        {},
        { timeout: 30_000 },
      );
      expect(result).toEqual(mockEstoque[0]);
    });

    it('deve retornar null se produto não encontrado', async () => {
      const codProduto = 99999;
      const empresa = '3';

      openQueryService.query.mockResolvedValue([]);

      const result = await repository.getEstoqueProduto(codProduto, empresa);

      expect(result).toBeNull();
    });

    it('deve rejeitar com empresa inválida', async () => {
      const codProduto = 12345;
      const empresa = 'empresa-invalida';

      await expect(repository.getEstoqueProduto(codProduto, empresa)).rejects.toThrow('Empresa inválida');
    });
  });

  describe('updateLiberadoContagem', () => {
    const DATA_ITEM = new Date('2024-01-15T00:00:00Z');

    /**
     * A conclusão de uma rodada passou a reavaliar cada produto olhando TODAS as suas
     * locações (inclusive as que estão em outra sessão/piso). Este helper monta os mocks
     * do Prisma respondendo de acordo com a consulta feita.
     */
    function configurarCenario(opts: {
      itensDaSessao: Array<{ id: string; cod_produto: number; data?: Date }>;
      itensDoProduto: Array<{
        id: string;
        contagem_cuid: string;
        localizacao?: string;
        identificador_item?: string;
        estoque: number;
      }>;
      cuidsAtivos: string[];
      logs: Array<{ item_id: string; contado: number; rodada: number; estoque: number }>;
      proximaContagem?: Array<{ id: string }>;
      rodadasLiberadas?: Array<{ id: string; contagem: number; logs: number }>;
      itensPendentes?: number;
      retornoFindFirst?: any;
    }) {
      mockPrismaService.est_contagem_itens.findMany.mockImplementation((args: any) =>
        Promise.resolve(
          args?.select?.estoque
            ? opts.itensDoProduto.map(i => ({
              localizacao: null,
              identificador_item: null,
              ...i,
            }))
            : opts.itensDaSessao.map(i => ({ data: DATA_ITEM, ...i })),
        ),
      );

      mockPrismaService.est_contagem.findMany.mockImplementation((args: any) => {
        if (args?.where?.status === 0 && args?.select?.contagem_cuid) {
          return Promise.resolve(opts.cuidsAtivos.map(c => ({ contagem_cuid: c })));
        }
        if (args?.where?.contagem?.gt === 1) {
          return Promise.resolve(
            (opts.rodadasLiberadas ?? []).map(r => ({
              id: r.id,
              contagem: r.contagem,
              _count: { logs: r.logs },
            })),
          );
        }
        return Promise.resolve(opts.proximaContagem ?? []);
      });

      mockPrismaService.est_contagem_log.findMany.mockResolvedValue(
        opts.logs.map(l => ({
          item_id: l.item_id,
          contado: l.contado,
          estoque: l.estoque,
          contagem: { contagem: l.rodada, status: 0 },
        })),
      );

      mockPrismaService.est_contagem_itens.count.mockResolvedValue(opts.itensPendentes ?? 0);
      mockPrismaService.est_contagem_itens.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.est_contagem.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.est_contagem.findFirst.mockResolvedValue(opts.retornoFindFirst ?? null);
    }

    const chamadasLiberando = () =>
      mockPrismaService.est_contagem.updateMany.mock.calls.filter(
        ([arg]: any[]) => arg?.data?.liberado_contagem === true,
      );

    it('deve liberar contagem tipo 2 quando há divergência na contagem tipo 1', async () => {
      const contagem_cuid = 'grupo-123';

      const mockContagemLiberada = {
        id: 'contagem-456',
        contagem_cuid: 'grupo-123',
        contagem: 2,
        liberado_contagem: true,
        colaborador: 'user-789',
        created_at: new Date('2024-01-15T10:00:00Z'),
      };

      configurarCenario({
        itensDaSessao: [{ id: 'item-1', cod_produto: 12345 }],
        itensDoProduto: [{ id: 'item-1', contagem_cuid, estoque: 100 }],
        cuidsAtivos: [contagem_cuid],
        logs: [{ item_id: 'item-1', contado: 90, rodada: 1, estoque: 100 }],
        proximaContagem: [{ id: 'contagem-456' }],
        retornoFindFirst: mockContagemLiberada,
      });

      const result = await repository.updateLiberadoContagem(contagem_cuid, 1, true);

      // Primeira chamada: trava a contagem tipo 1 e grava o fim (data_fim).
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(1, {
        where: { contagem_cuid, contagem: 1 },
        data: { liberado_contagem: false, data_fim: expect.any(Date) },
      });

      // A divergência real (90 contados x 100 de estoque) libera a contagem tipo 2.
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(2, {
        where: { contagem_cuid, contagem: 2 },
        data: { liberado_contagem: true },
      });

      expect(mockPrismaService.est_contagem_itens.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['item-1'] } },
        data: { conferir: true },
      });

      expect(result).toEqual(mockContagemLiberada);
    });

    it('deve liberar contagem tipo 3 quando há divergência na contagem tipo 2', async () => {
      const contagem_cuid = 'grupo-123';

      const mockContagemLiberada = {
        id: 'contagem-789',
        contagem_cuid: 'grupo-123',
        contagem: 3,
        liberado_contagem: true,
        colaborador: 'user-789',
        created_at: new Date('2024-01-15T10:00:00Z'),
      };

      configurarCenario({
        itensDaSessao: [{ id: 'item-1', cod_produto: 12345 }],
        itensDoProduto: [{ id: 'item-1', contagem_cuid, estoque: 100 }],
        cuidsAtivos: [contagem_cuid],
        logs: [
          { item_id: 'item-1', contado: 90, rodada: 1, estoque: 100 },
          { item_id: 'item-1', contado: 95, rodada: 2, estoque: 100 },
        ],
        proximaContagem: [{ id: 'contagem-789' }],
        retornoFindFirst: mockContagemLiberada,
      });

      const result = await repository.updateLiberadoContagem(contagem_cuid, 2, true);

      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(2, {
        where: { contagem_cuid, contagem: 3 },
        data: { liberado_contagem: true },
      });

      expect(result).toEqual(mockContagemLiberada);
    });

    it('não deve liberar próxima contagem na contagem tipo 3 (última)', async () => {
      const contagem_cuid = 'grupo-123';

      configurarCenario({
        itensDaSessao: [{ id: 'item-1', cod_produto: 12345 }],
        itensDoProduto: [{ id: 'item-1', contagem_cuid, estoque: 100 }],
        cuidsAtivos: [contagem_cuid],
        logs: [{ item_id: 'item-1', contado: 90, rodada: 3, estoque: 100 }],
      });

      await repository.updateLiberadoContagem(contagem_cuid, 3, true);

      // Na contagem 3 não existe "próxima" para liberar com liberado_contagem: true
      expect(chamadasLiberando()).toHaveLength(0);
    });

    it('não deve liberar próxima contagem quando não há divergência', async () => {
      const contagem_cuid = 'grupo-123';

      const mockContagemAtual = {
        id: 'contagem-123',
        contagem_cuid: 'grupo-123',
        contagem: 1,
        liberado_contagem: false,
      };

      configurarCenario({
        itensDaSessao: [{ id: 'item-1', cod_produto: 12345 }],
        itensDoProduto: [{ id: 'item-1', contagem_cuid, estoque: 100 }],
        cuidsAtivos: [contagem_cuid],
        logs: [{ item_id: 'item-1', contado: 100, rodada: 1, estoque: 100 }],
        retornoFindFirst: mockContagemAtual,
      });

      const result = await repository.updateLiberadoContagem(contagem_cuid, 1, false);

      expect(chamadasLiberando()).toHaveLength(0);
      expect(result).toEqual(mockContagemAtual);
    });

    it('não libera nada quando a locação da OUTRA sessão já fechou o produto, mesmo com o front acusando divergência', async () => {
      // Sessão da vitrine (VM601B02) conta 0 e, sozinha, não fecha com o estoque 18.
      // Mas a locação C1306B02, contada na sessão do corredor, já fechou os 18.
      const contagem_cuid = 'sessao-vitrine';

      configurarCenario({
        itensDaSessao: [{ id: 'item-vm', cod_produto: 38677 }],
        itensDoProduto: [
          { id: 'item-c13', contagem_cuid: 'sessao-corredor', estoque: 18 },
          { id: 'item-vm', contagem_cuid, estoque: 18 },
        ],
        cuidsAtivos: ['sessao-corredor', contagem_cuid],
        logs: [
          { item_id: 'item-c13', contado: 18, rodada: 1, estoque: 18 },
          { item_id: 'item-vm', contado: 0, rodada: 1, estoque: 18 },
        ],
        retornoFindFirst: { id: 'contagem-vm-1', contagem: 1, liberado_contagem: false },
      });

      await repository.updateLiberadoContagem(contagem_cuid, 1, true);

      expect(chamadasLiberando()).toHaveLength(0);

      // As DUAS locações saem do funil, não só a desta sessão.
      expect(mockPrismaService.est_contagem_itens.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['item-c13', 'item-vm'] } },
        data: { conferir: false },
      });
    });

    it('segue para a próxima contagem quando a outra locação ainda NÃO foi contada (não trava esperando)', async () => {
      // A vitrine concluiu a 1ª contagem antes de o corredor contar a outra locação.
      // Sem o total não dá para dizer que fechou -> a sessão segue para a 2ª contagem.
      // (Se o corredor fechar o produto depois, essa 2ª contagem é revogada — teste abaixo.)
      const contagem_cuid = 'sessao-vitrine';

      configurarCenario({
        itensDaSessao: [{ id: 'item-vm', cod_produto: 38677 }],
        itensDoProduto: [
          { id: 'item-c13', contagem_cuid: 'sessao-corredor', estoque: 18 },
          { id: 'item-vm', contagem_cuid, estoque: 18 },
        ],
        cuidsAtivos: ['sessao-corredor', contagem_cuid],
        logs: [{ item_id: 'item-vm', contado: 0, rodada: 1, estoque: 18 }],
        proximaContagem: [{ id: 'contagem-vm-2' }],
        retornoFindFirst: { id: 'contagem-vm-2', contagem: 2, liberado_contagem: true },
      });

      await repository.updateLiberadoContagem(contagem_cuid, 1, true);

      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenCalledWith({
        where: { contagem_cuid, contagem: 2 },
        data: { liberado_contagem: true },
      });

      // E só as locações DESTA sessão são marcadas para recontagem.
      expect(mockPrismaService.est_contagem_itens.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['item-vm'] } },
        data: { conferir: true },
      });
    });

    it('revoga a rodada que a outra sessão havia liberado quando o produto fecha depois', async () => {
      // A sessão da vitrine concluiu antes e foi liberada para a 2ª contagem. Agora a
      // sessão do corredor conta a outra locação e o produto fecha: a 2ª contagem da
      // vitrine, ainda não iniciada, é fechada de volta.
      const contagem_cuid = 'sessao-corredor';

      configurarCenario({
        itensDaSessao: [{ id: 'item-c13', cod_produto: 38677 }],
        itensDoProduto: [
          { id: 'item-c13', contagem_cuid, estoque: 18 },
          { id: 'item-vm', contagem_cuid: 'sessao-vitrine', estoque: 18 },
        ],
        cuidsAtivos: [contagem_cuid, 'sessao-vitrine'],
        logs: [
          { item_id: 'item-c13', contado: 18, rodada: 1, estoque: 18 },
          { item_id: 'item-vm', contado: 0, rodada: 1, estoque: 18 },
        ],
        rodadasLiberadas: [{ id: 'contagem-vm-2', contagem: 2, logs: 0 }],
        itensPendentes: 0,
        retornoFindFirst: { id: 'contagem-c13-1', contagem: 1, liberado_contagem: false },
      });

      await repository.updateLiberadoContagem(contagem_cuid, 1, false);

      expect(chamadasLiberando()).toHaveLength(0);
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['contagem-vm-2'] } },
        data: { liberado_contagem: false },
      });
    });

    it('não revoga rodada da outra sessão que já foi iniciada nem quando ela ainda tem itens pendentes', async () => {
      const contagem_cuid = 'sessao-corredor';

      configurarCenario({
        itensDaSessao: [{ id: 'item-c13', cod_produto: 38677 }],
        itensDoProduto: [
          { id: 'item-c13', contagem_cuid, estoque: 18 },
          { id: 'item-vm', contagem_cuid: 'sessao-vitrine', estoque: 18 },
        ],
        cuidsAtivos: [contagem_cuid, 'sessao-vitrine'],
        logs: [
          { item_id: 'item-c13', contado: 18, rodada: 1, estoque: 18 },
          { item_id: 'item-vm', contado: 0, rodada: 1, estoque: 18 },
        ],
        // A 2ª contagem da vitrine já tem logs -> trabalho em andamento, não se mexe.
        rodadasLiberadas: [{ id: 'contagem-vm-2', contagem: 2, logs: 3 }],
        retornoFindFirst: { id: 'contagem-c13-1', contagem: 1, liberado_contagem: false },
      });

      await repository.updateLiberadoContagem(contagem_cuid, 1, false);

      const revogacoes = mockPrismaService.est_contagem.updateMany.mock.calls.filter(
        ([arg]: any[]) => arg?.where?.id?.in && arg?.data?.liberado_contagem === false,
      );
      expect(revogacoes).toHaveLength(0);
    });
  });

  describe('getContagensByGrupo', () => {
    it('deve retornar todas as contagens de um grupo com itens compartilhados', async () => {
      const contagem_cuid = 'grupo-123';

      const mockContagens = [
        {
          id: 'contagem-1',
          colaborador: 'user-123',
          contagem: 1,
          contagem_cuid: 'grupo-123',
          liberado_contagem: true,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: {
            id: 'user-123',
            nome: 'JOÃO DA SILVA',
            codigo: 'JS001',
          },
        },
        {
          id: 'contagem-2',
          colaborador: 'user-456',
          contagem: 2,
          contagem_cuid: 'grupo-123',
          liberado_contagem: false,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: {
            id: 'user-456',
            nome: 'MARIA SANTOS',
            codigo: 'MS002',
          },
        },
      ];

      const mockItens = [
        {
          id: 'item-789',
          contagem_cuid: 'grupo-123',
          data: new Date('2024-01-15T00:00:00Z'),
          cod_produto: 12345,
          desc_produto: 'PRODUTO TESTE',
          mar_descricao: 'MARCA TESTE',
          ref_fabricante: 'REF123',
          ref_fornecedor: 'FORN123',
          localizacao: 'A01-B02',
          unidade: 'UN',
          qtde_saida: 5,
          estoque: 100,
          reserva: 10,
          conferir: false,
        },
      ];

      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);
      mockPrismaService.est_contagem_itens.findMany.mockResolvedValue(mockItens);

      const result = await repository.getContagensByGrupo(contagem_cuid);

      expect(mockPrismaService.est_contagem.findMany).toHaveBeenCalledWith({
        where: { contagem_cuid },
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              codigo: true,
            },
          },
        },
        orderBy: { contagem: 'asc' },
      });

      expect(mockPrismaService.est_contagem_itens.findMany).toHaveBeenCalledWith({
        where: { contagem_cuid },
        orderBy: { cod_produto: 'asc' },
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('itens');
      expect(result[1]).toHaveProperty('itens');
      expect(result[0].itens).toEqual(mockItens);
      expect(result[1].itens).toEqual(mockItens);
    });
  });

  describe('getAllContagens', () => {
    it('deve retornar contagens paginadas com total e last_page', async () => {
      const mockContagens = [
        {
          id: 'contagem-123',
          colaborador: 'user-123',
          contagem: 1,
          contagem_cuid: 'grupo-456',
          liberado_contagem: true,
          status: 0,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: { id: 'user-123', nome: 'JOÃO DA SILVA', codigo: 'JS001' },
          logs: [],
        },
        {
          id: 'contagem-456',
          colaborador: 'user-456',
          contagem: 2,
          contagem_cuid: 'grupo-789',
          liberado_contagem: false,
          status: 0,
          created_at: new Date('2024-01-16T10:00:00Z'),
          usuario: { id: 'user-456', nome: 'MARIA SANTOS', codigo: 'MS002' },
          logs: [],
        },
      ];

      mockPrismaService.est_contagem.count.mockResolvedValue(2);
      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);
      mockPrismaService.est_contagem_itens.findFirst.mockResolvedValue({
        data: new Date('2024-01-15T00:00:00Z'),
      });
      mockPrismaService.est_contagem_log.findFirst.mockResolvedValue(null);

      const result = await repository.getAllContagens({ page: 1, pageSize: 20 });

      // Paginação aplicada
      expect(mockPrismaService.est_contagem.count).toHaveBeenCalledWith({
        where: { status: 0 },
      });
      expect(mockPrismaService.est_contagem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );

      // Novo formato de retorno
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.last_page).toBe(1);
      expect(result.data).toHaveLength(2);
      expect(result.data[0].usuario.nome).toBe('JOÃO DA SILVA');
      expect(result.data[0]).toHaveProperty('grupo_iniciado', false);
    });

    it('deve retornar data vazio quando não há contagens', async () => {
      mockPrismaService.est_contagem.count.mockResolvedValue(0);
      mockPrismaService.est_contagem.findMany.mockResolvedValue([]);

      const result = await repository.getAllContagens();

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.last_page).toBe(0);
    });

    it('deve tratar contagem com contagem_cuid null sem quebrar', async () => {
      const mockContagens = [
        {
          id: 'contagem-123',
          colaborador: 'user-123',
          contagem: 1,
          contagem_cuid: null,
          liberado_contagem: true,
          status: 0,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: { id: 'user-123', nome: 'JOÃO DA SILVA', codigo: 'JS001' },
          logs: [],
        },
      ];

      mockPrismaService.est_contagem.count.mockResolvedValue(1);
      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);
      mockPrismaService.est_contagem_itens.findFirst.mockResolvedValue(null);

      const result = await repository.getAllContagens();

      expect(result.data).toHaveLength(1);
      // Sem CUID e sem item => grupo não iniciado e sem itens
      expect(result.data[0].grupo_iniciado).toBe(false);
      expect(result.data[0].itens).toEqual([]);
    });
  });
});