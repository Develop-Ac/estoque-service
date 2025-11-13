import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EstoqueSaidasService } from './contagem.service';
import { EstoqueSaidasRepository } from './contagem.repository';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ContagemResponseDto } from './dto/contagem-response.dto';

describe('EstoqueSaidasService', () => {
  let service: EstoqueSaidasService;
  let repository: jest.Mocked<EstoqueSaidasRepository>;

  const mockEstoqueSaidasRepository = {
    fetchSaidas: jest.fn(),
    createContagem: jest.fn(),
    getContagensByUsuario: jest.fn(),
    updateItemConferir: jest.fn(),
    getEstoqueProduto: jest.fn(),
    updateLiberadoContagem: jest.fn(),
    getContagensByGrupo: jest.fn(),
    getAllContagens: jest.fn(),
    createLog: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EstoqueSaidasService,
        {
          provide: EstoqueSaidasRepository,
          useValue: mockEstoqueSaidasRepository,
        },
      ],
    }).compile();

    service = module.get<EstoqueSaidasService>(EstoqueSaidasService);
    repository = module.get<EstoqueSaidasRepository>(EstoqueSaidasRepository) as jest.Mocked<EstoqueSaidasRepository>;
  }); 

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('listarSaidas', () => {
    it('deve retornar lista de saídas do estoque', async () => {
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
          APLICACOES: 'APLICAÇÃO TESTE',
          codigo_barras: '1234567890123',
          QTDE_SAIDA: 5,
          ESTOQUE: 100,
          RESERVA: 10,
        },
      ];

      const filters = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      repository.fetchSaidas.mockResolvedValue(mockSaidas);

      const result = await service.listarSaidas(filters);

      expect(repository.fetchSaidas).toHaveBeenCalledWith(filters);
      expect(result).toEqual(mockSaidas);
    });

    it('deve repassar erro do repository', async () => {
      const filters = {
        data_inicial: '2024-01-01',
        data_final: '2024-01-31',
        empresa: '3',
      };

      repository.fetchSaidas.mockRejectedValue(new Error('Erro na consulta'));

      await expect(service.listarSaidas(filters)).rejects.toThrow('Erro na consulta');
    });
  });

  describe('createContagem', () => {
    it('deve criar uma nova contagem', async () => {
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
            APLICACOES: 'APLICAÇÃO TESTE',
            QTDE_SAIDA: 5,
            ESTOQUE: 100,
            RESERVA: 10,
          },
        ],
      };

      const mockContagemResponse: ContagemResponseDto = {
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
        itens: [
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
            aplicacoes: 'APLICAÇÃO TESTE',
            qtde_saida: 5,
            estoque: 100,
            reserva: 10,
            conferir: false,
          },
        ],
      };

      repository.createContagem.mockResolvedValue(mockContagemResponse as any);

      const result = await service.createContagem(createContagemDto);

      expect(repository.createContagem).toHaveBeenCalledWith(createContagemDto);
      expect(result).toEqual(mockContagemResponse);
    });

    it('deve repassar erro de usuário não encontrado', async () => {
      const createContagemDto: CreateContagemDto = {
        colaborador: 'USUÁRIO INEXISTENTE',
        contagem: 1,
        contagem_cuid: 'grupo-123',
        produtos: [],
      };

      repository.createContagem.mockRejectedValue(
        new BadRequestException('Colaborador com nome "USUÁRIO INEXISTENTE" não encontrado'),
      );

      await expect(service.createContagem(createContagemDto)).rejects.toThrow(
        'Colaborador com nome "USUÁRIO INEXISTENTE" não encontrado',
      );
    });
  });

  describe('getContagensByUsuario', () => {
    it('deve retornar contagens do usuário com itens mapeados', async () => {
      const idUsuario = 'user-123';
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
          itens: [
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
              aplicacoes: 'APLICAÇÃO TESTE',
              qtde_saida: 5,
              estoque: 100,
              reserva: 10,
              conferir: false,
            },
          ],
        },
      ];

      repository.getContagensByUsuario.mockResolvedValue(mockContagens);

      const result = await service.getContagensByUsuario(idUsuario);

      expect(repository.getContagensByUsuario).toHaveBeenCalledWith(idUsuario);
      expect(result).toHaveLength(1);
      expect(result[0]?.itens?.[0]).toHaveProperty('contagem_id', 'grupo-456');
    });

    it('deve repassar erro de usuário não encontrado', async () => {
      const idUsuario = 'user-inexistente';

      repository.getContagensByUsuario.mockRejectedValue(
        new BadRequestException('Usuário com ID "user-inexistente" não encontrado'),
      );

      await expect(service.getContagensByUsuario(idUsuario)).rejects.toThrow(
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
        contagem_cuid: 'grupo-456',
        data: new Date('2024-01-15T00:00:00Z'),
        cod_produto: 12345,
        desc_produto: 'PRODUTO TESTE',
        mar_descricao: 'MARCA TESTE',
        ref_fabricante: 'REF123',
        ref_fornecedor: 'FORN123',
        localizacao: 'A01-B02',
        unidade: 'UN',
        aplicacoes: 'APLICAÇÃO TESTE',
        qtde_saida: 5,
        estoque: 100,
        reserva: 10,
        conferir: true,
      };

      repository.updateItemConferir.mockResolvedValue(mockUpdatedItem);

      const result = await service.updateItemConferir(itemId, conferir);

      expect(repository.updateItemConferir).toHaveBeenCalledWith(itemId, conferir);
      expect(result).toEqual(mockUpdatedItem);
    });
  });

  describe('getEstoqueProduto', () => {
    it('deve retornar estoque do produto', async () => {
      const codProduto = 12345;
      const empresa = '3';
      const mockEstoque = {
        pro_codigo: 12345,
        ESTOQUE: 15,
      };

      repository.getEstoqueProduto.mockResolvedValue(mockEstoque);

      const result = await service.getEstoqueProduto(codProduto, empresa);

      expect(repository.getEstoqueProduto).toHaveBeenCalledWith(codProduto, empresa);
      expect(result).toEqual(mockEstoque);
    });

    it('deve retornar null se produto não encontrado', async () => {
      const codProduto = 99999;
      const empresa = '3';

      repository.getEstoqueProduto.mockResolvedValue(null);

      const result = await service.getEstoqueProduto(codProduto, empresa);

      expect(repository.getEstoqueProduto).toHaveBeenCalledWith(codProduto, empresa);
      expect(result).toBeNull();
    });
  });

  describe('updateLiberadoContagem', () => {
    it('deve liberar próxima contagem', async () => {
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

      repository.updateLiberadoContagem.mockResolvedValue(mockContagemLiberada);

      const result = await service.updateLiberadoContagem(contagem_cuid, contagem, divergencia);

      expect(repository.updateLiberadoContagem).toHaveBeenCalledWith(contagem_cuid, contagem, divergencia);
      expect(result).toEqual(mockContagemLiberada);
    });

    it('deve repassar erro se contagem não encontrada', async () => {
      const contagem_cuid = 'grupo-inexistente';
      const contagem = 1;
      const divergencia = false;

      repository.updateLiberadoContagem.mockRejectedValue(
        new BadRequestException('Nenhuma contagem encontrada com contagem_cuid "grupo-inexistente" e tipo 2'),
      );

      await expect(service.updateLiberadoContagem(contagem_cuid, contagem, divergencia)).rejects.toThrow(
        'Nenhuma contagem encontrada com contagem_cuid "grupo-inexistente" e tipo 2',
      );
    });
  });

  describe('getContagensByGrupo', () => {
    it('deve retornar contagens do grupo com itens mapeados', async () => {
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
          itens: [
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
              aplicacoes: 'APLICAÇÃO TESTE',
              qtde_saida: 5,
              estoque: 100,
              reserva: 10,
              conferir: false,
            },
          ],
        },
      ];

      repository.getContagensByGrupo.mockResolvedValue(mockContagens);

      const result = await service.getContagensByGrupo(contagem_cuid);

      expect(repository.getContagensByGrupo).toHaveBeenCalledWith(contagem_cuid);
      expect(result).toHaveLength(1);
      expect(result[0]?.itens?.[0]).toHaveProperty('contagem_id', 'grupo-123');
    });
  });

  describe('getAllContagens', () => {
    it('deve retornar todas as contagens com logs', async () => {
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
          logs: [
            {
              id: 'log-789',
              contagem_id: 'contagem-123',
              usuario_id: 'user-123',
              item_id: 'item-456',
              estoque: 100,
              contado: 95,
              created_at: new Date('2024-01-15T10:30:00Z'),
              item: {
                cod_produto: 12345,
                desc_produto: 'PRODUTO TESTE'
              }
            },
          ],
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
          logs: [
            {
              id: 'log-101',
              contagem_id: 'contagem-456',
              usuario_id: 'user-456',
              item_id: 'item-789',
              estoque: 50,
              contado: 48,
              created_at: new Date('2024-01-16T10:30:00Z'),
              item: {
                cod_produto: 67890,
                desc_produto: 'OUTRO PRODUTO TESTE'
              }
            },
          ],
        },
      ];

      repository.getAllContagens.mockResolvedValue(mockContagens);

      const result = await service.getAllContagens();

      expect(repository.getAllContagens).toHaveBeenCalledWith();
      expect(result).toHaveLength(2);
      expect(result[0].logs).toBeDefined();
      expect(result[1].logs).toBeDefined();
      expect(result[0].logs![0]).toHaveProperty('contagem_id', 'contagem-123');
      expect(result[1].logs![0]).toHaveProperty('contagem_id', 'contagem-456');
      expect(result[0].usuario.nome).toBe('JOÃO DA SILVA');
      expect(result[1].usuario.nome).toBe('MARIA SANTOS');
    });

    it('deve retornar array vazio quando não há contagens', async () => {
      repository.getAllContagens.mockResolvedValue([]);

      const result = await service.getAllContagens();

      expect(repository.getAllContagens).toHaveBeenCalledWith();
      expect(result).toEqual([]);
    });
  });
});