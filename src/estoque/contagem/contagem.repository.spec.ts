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
    },
    est_contagem_itens: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
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

      mockPrismaService.sis_usuarios.findUnique.mockResolvedValue(mockUsuario);
      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);
      mockPrismaService.est_contagem_itens.findMany.mockResolvedValue(mockItens);

      const result = await repository.getContagensByUsuario(idUsuario);

      expect(mockPrismaService.sis_usuarios.findUnique).toHaveBeenCalledWith({
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

      mockPrismaService.sis_usuarios.findUnique.mockResolvedValue(null);

      await expect(repository.getContagensByUsuario(idUsuario)).rejects.toThrow(
        'Usuário com ID "user-inexistente" não encontrado',
      );
    });
  });

  describe('updateItemConferir', () => {
    it('deve atualizar campo conferir do item', async () => {
      const itemId = 'item-123';
      const conferir = true;

      const mockUpdatedItem = {
        id: 'item-123',
        conferir: true,
        contagem_cuid: 'grupo-456',
        cod_produto: 12345,
        desc_produto: 'PRODUTO TESTE',
      };

      mockPrismaService.est_contagem_itens.update.mockResolvedValue(mockUpdatedItem);

      const result = await repository.updateItemConferir(itemId, conferir);

      expect(mockPrismaService.est_contagem_itens.update).toHaveBeenCalledWith({
        where: { id: itemId },
        data: { conferir },
      });
      expect(result).toEqual(mockUpdatedItem);
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
    it('deve liberar contagem tipo 2 quando recebe contagem tipo 1', async () => {
      const contagem_cuid = 'grupo-123';
      const contagem = 1;
      const divergencia = false;

      const mockContagemLiberada = {
        id: 'contagem-456',
        contagem_cuid: 'grupo-123',
        contagem: 2,
        liberado_contagem: true,
        colaborador: 'user-789',
        created_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockPrismaService.est_contagem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // Para desabilitar contagem atual
        .mockResolvedValueOnce({ count: 1 }); // Para liberar próxima contagem

      mockPrismaService.est_contagem.findFirst.mockResolvedValue(mockContagemLiberada);

      const result = await repository.updateLiberadoContagem(contagem_cuid, contagem, divergencia);

      // Primeira chamada: desabilita contagem tipo 1
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(1, {
        where: { contagem_cuid, contagem: 1 },
        data: { liberado_contagem: false },
      });

      // Segunda chamada: libera contagem tipo 2
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(2, {
        where: { contagem_cuid, contagem: 2 },
        data: { liberado_contagem: true },
      });

      expect(result).toEqual(mockContagemLiberada);
    });

    it('deve liberar contagem tipo 3 quando recebe contagem tipo 2', async () => {
      const contagem_cuid = 'grupo-123';
      const contagem = 2;
      const divergencia = false;

      const mockContagemLiberada = {
        id: 'contagem-456',
        contagem_cuid: 'grupo-123',
        contagem: 3,
        liberado_contagem: true,
        colaborador: 'user-789',
        created_at: new Date('2024-01-15T10:00:00Z'),
      };

      mockPrismaService.est_contagem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // Para desabilitar contagem atual
        .mockResolvedValueOnce({ count: 1 }); // Para liberar próxima contagem

      mockPrismaService.est_contagem.findFirst.mockResolvedValue(mockContagemLiberada);

      const result = await repository.updateLiberadoContagem(contagem_cuid, contagem, divergencia);

      // Primeira chamada: desabilita contagem tipo 2
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(1, {
        where: { contagem_cuid, contagem: 2 },
        data: { liberado_contagem: false },
      });

      // Segunda chamada: libera contagem tipo 3
      expect(mockPrismaService.est_contagem.updateMany).toHaveBeenNthCalledWith(2, {
        where: { contagem_cuid, contagem: 3 },
        data: { liberado_contagem: true },
      });

      expect(result).toEqual(mockContagemLiberada);
    });

    it('deve rejeitar se contagem para liberar não encontrada', async () => {
      const contagem_cuid = 'grupo-inexistente';
      const contagem = 1;
      const divergencia = false;

      mockPrismaService.est_contagem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // Para desabilitar contagem atual
        .mockResolvedValueOnce({ count: 0 }); // Para liberar próxima contagem (não encontrada)

      await expect(repository.updateLiberadoContagem(contagem_cuid, contagem, divergencia)).rejects.toThrow(
        'Nenhuma contagem encontrada com contagem_cuid "grupo-inexistente" e tipo 2',
      );
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
    it('deve retornar todas as contagens com itens', async () => {
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
          logs: []
        },
        {
          id: 'contagem-456',
          colaborador: 'user-456',
          contagem: 2,
          contagem_cuid: 'grupo-789',
          liberado_contagem: false,
          created_at: new Date('2024-01-16T10:00:00Z'),
          usuario: {
            id: 'user-456',
            nome: 'MARIA SANTOS',
            codigo: 'MS002',
          },
          logs: []
        },
      ];

      const mockItens1 = [
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

      const mockItens2 = [
        {
          id: 'item-101',
          contagem_cuid: 'grupo-789',
          data: new Date('2024-01-16T00:00:00Z'),
          cod_produto: 67890,
          desc_produto: 'OUTRO PRODUTO TESTE',
          mar_descricao: 'OUTRA MARCA',
          ref_fabricante: 'REF456',
          ref_fornecedor: 'FORN456',
          localizacao: 'B02-C03',
          unidade: 'PC',
          qtde_saida: 3,
          estoque: 50,
          reserva: 5,
          conferir: true,
        },
      ];

      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);

      const result = await repository.getAllContagens();

      expect(mockPrismaService.est_contagem.findMany).toHaveBeenCalledWith({
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              codigo: true,
            },
          },
          logs: {
            select: {
              id: true,
              contagem_id: true,
              usuario_id: true,
              item_id: true,
              estoque: true,
              contado: true,
              created_at: true
            },
            orderBy: {
              created_at: 'desc'
            }
          }
        },
        orderBy: {
          created_at: 'desc',
        },
      });

      expect(result).toHaveLength(2);
      expect(result[0]).not.toHaveProperty('itens');
      expect(result[1]).not.toHaveProperty('itens');
      expect(result[0].usuario.nome).toBe('JOÃO DA SILVA');
      expect(result[1].usuario.nome).toBe('MARIA SANTOS');
    });

    it('deve retornar array vazio quando não há contagens', async () => {
      mockPrismaService.est_contagem.findMany.mockResolvedValue([]);

      const result = await repository.getAllContagens();

      expect(mockPrismaService.est_contagem.findMany).toHaveBeenCalledWith({
        include: {
          usuario: {
            select: {
              id: true,
              nome: true,
              codigo: true,
            },
          },
          logs: {
            select: {
              id: true,
              contagem_id: true,
              usuario_id: true,
              item_id: true,
              estoque: true,
              contado: true,
              created_at: true
            },
            orderBy: {
              created_at: 'desc'
            }
          }
        },
        orderBy: {
          created_at: 'desc',
        },
      });

      expect(result).toEqual([]);
    });

    it('deve retornar contagens sem itens quando contagem_cuid é null', async () => {
      const mockContagens = [
        {
          id: 'contagem-123',
          colaborador: 'user-123',
          contagem: 1,
          contagem_cuid: null,
          liberado_contagem: true,
          created_at: new Date('2024-01-15T10:00:00Z'),
          usuario: {
            id: 'user-123',
            nome: 'JOÃO DA SILVA',
            codigo: 'JS001',
          },
        },
      ];

      mockPrismaService.est_contagem.findMany.mockResolvedValue(mockContagens);

      const result = await repository.getAllContagens();

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('itens');
    });
  });
});