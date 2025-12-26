import { Body, Controller, Get, Post, Query, Param, Put, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiInternalServerErrorResponse,
  ApiExtraModels,
  ApiCreatedResponse,
  ApiParam
} from '@nestjs/swagger';
import { EstoqueSaidasService } from './contagem.service';
import { GetSaidasQueryDto } from './dto/get-saidas.query.dto';
import { EstoqueSaidaRow } from './contagem.types';
import { EstoqueSaidaResponseDto } from './dto/estoque-saida-response.dto';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ContagemResponseDto } from './dto/contagem-response.dto';
import { UpdateConferirDto } from './dto/update-conferir.dto';
import { ConferirEstoqueResponseDto } from './dto/conferir-estoque-response.dto';
import { UpdateLiberadoContagemDto } from './dto/update-liberado-contagem.dto';
import { CreateLogDto } from './dto/create-log.dto';
import { LogResponseDto } from './dto/log-response.dto';

@ApiTags('Estoque')
@ApiExtraModels(GetSaidasQueryDto, EstoqueSaidaResponseDto, CreateContagemDto, ContagemResponseDto, UpdateConferirDto, ConferirEstoqueResponseDto, UpdateLiberadoContagemDto, CreateLogDto, LogResponseDto)
@Controller('contagem')
export class EstoqueSaidasController {
  constructor(private readonly service: EstoqueSaidasService) { }

  @Get()
  @ApiOperation({
    summary: 'Consultar saídas do estoque',
    description: 'Lista as movimentações de saída do estoque em um período específico para uma empresa'
  })
  @ApiQuery({
    name: 'data_inicial',
    description: 'Data inicial para consulta (formato: YYYY-MM-DD)',
    example: '2024-01-01',
    required: true,
    type: 'string'
  })
  @ApiQuery({
    name: 'data_final',
    description: 'Data final para consulta (formato: YYYY-MM-DD)',
    example: '2024-01-31',
    required: true,
    type: 'string'
  })
  @ApiQuery({
    name: 'empresa',
    description: 'Código da empresa',
    example: '3',
    required: false,
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Lista de saídas do estoque retornada com sucesso',
    type: EstoqueSaidaResponseDto,
    isArray: true,
    example: [
      {
        data: '2024-01-15',
        COD_PRODUTO: 12345,
        DESC_PRODUTO: 'PRODUTO EXEMPLO ABC',
        mar_descricao: 'MARCA EXEMPLO',
        ref_fabricante: 'REF123456',
        ref_FORNECEDOR: 'FORN789',
        LOCALIZACAO: 'A01-B02',
        unidade: 'UN',
        APLICACOES: 'APLICAÇÃO ESPECÍFICA DO PRODUTO',
        codigo_barras: '7891234567890',
        QTDE_SAIDA: 5,
        ESTOQUE: 100,
        RESERVA: 10
      }
    ]
  })
  @ApiBadRequestResponse({
    description: 'Parâmetros inválidos fornecidos',
    example: {
      statusCode: 400,
      message: ['data_inicial deve ser YYYY-MM-DD'],
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async getSaidas(@Query() q: GetSaidasQueryDto): Promise<EstoqueSaidaRow[]> {
    const { data_inicial, data_final, empresa = '3' } = q;
    return this.service.listarSaidas({ data_inicial, data_final, empresa });
  }

  @Get('lista')
  @ApiOperation({
    summary: 'Listar todas as contagens',
    description: 'Retorna uma lista de todas as contagens realizadas no sistema, incluindo todos os itens e logs de cada contagem'
  })
  @ApiOkResponse({
    description: 'Lista de todas as contagens retornada com sucesso',
    type: ContagemResponseDto,
    isArray: true,
    example: [
      {
        id: 'clx1234567890abcdef',
        colaborador: 'clx0987654321fedcba',
        contagem: 1,
        contagem_cuid: 'clx1234567890group',
        liberado_contagem: true,
        created_at: '2025-11-04T14:30:00.000Z',
        usuario: {
          id: 'clx0987654321fedcba',
          nome: 'DIOGO DA SILVA SANTOS',
          codigo: 'DS001'
        },
        itens: [
          {
            id: 'clx1111222233334444',
            contagem_id: 'clx1234567890abcdef',
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
        logs: [
          {
            id: 'clx5555666677778888',
            contagem_id: 'clx1234567890abcdef',
            usuario_id: 'clx0987654321fedcba',
            item_id: 'clx1111222233334444',
            estoque: 100,
            contado: 95,
            created_at: '2025-11-10T13:30:00.000Z',
            usuario: {
              id: 'clx0987654321fedcba',
              nome: 'JOÃO DA SILVA',
              codigo: 'JS001'
            },
            item: {
              id: 'clx1111222233334444',
              cod_produto: 23251,
              desc_produto: 'PRODUTO TESTE',
              localizacao: 'B1002A03'
            }
          }
        ]
      }
    ]
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async getAllContagens(): Promise<ContagemResponseDto[]> {
    return this.service.getAllContagens();
  }

  @Get(':id_usuario')
  @ApiOperation({
    summary: 'Listar contagens de um usuário',
    description: 'Retorna uma lista das contagens realizadas por um usuário específico, incluindo todos os itens de cada contagem'
  })
  @ApiParam({
    name: 'id_usuario',
    description: 'ID único do usuário/colaborador',
    example: 'clx0987654321fedcba',
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Lista de contagens do usuário retornada com sucesso',
    type: ContagemResponseDto,
    isArray: true,
    example: [
      {
        id: 'clx1234567890abcdef',
        colaborador: 'clx0987654321fedcba',
        contagem: 1,
        contagem_cuid: 'clx1234567890group',
        liberado_contagem: true,
        created_at: '2025-11-04T14:30:00.000Z',
        usuario: {
          id: 'clx0987654321fedcba',
          nome: 'DIOGO DA SILVA SANTOS',
          codigo: 'DS001'
        },
        itens: [
          {
            id: 'clx1111222233334444',
            contagem_id: 'clx1234567890abcdef',
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
        ]
      }
    ]
  })
  @ApiBadRequestResponse({
    description: 'ID do usuário inválido ou usuário não encontrado',
    example: {
      statusCode: 400,
      message: 'Usuário com ID "invalid-id" não encontrado',
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async getContagensByUsuario(@Param('id_usuario') idUsuario: string): Promise<ContagemResponseDto[]> {
    return this.service.getContagensByUsuario(idUsuario);
  }

  @Get('grupo/:contagem_cuid')
  @ApiOperation({
    summary: 'Listar contagens de um grupo específico',
    description: 'Retorna as 3 contagens (tipos 1, 2, 3) de um grupo específico identificado pelo contagem_cuid'
  })
  @ApiParam({
    name: 'contagem_cuid',
    description: 'Identificador único do grupo de contagens',
    example: 'clx1234567890group',
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Lista de contagens do grupo retornada com sucesso',
    type: ContagemResponseDto,
    isArray: true,
    example: [
      {
        id: 'clx1234567890type1',
        contagem: 1,
        contagem_cuid: 'clx1234567890group',
        liberado_contagem: true
      },
      {
        id: 'clx1234567890type2',
        contagem: 2,
        contagem_cuid: 'clx1234567890group',
        liberado_contagem: false
      },
      {
        id: 'clx1234567890type3',
        contagem: 3,
        contagem_cuid: 'clx1234567890group',
        liberado_contagem: false
      }
    ]
  })
  @ApiBadRequestResponse({
    description: 'Grupo de contagens não encontrado',
    example: {
      statusCode: 400,
      message: 'Grupo não encontrado',
      error: 'Bad Request'
    }
  })
  async getContagensByGrupo(@Param('contagem_cuid') contagemCuid: string): Promise<ContagemResponseDto[]> {
    return this.service.getContagensByGrupo(contagemCuid);
  }

  @Post()
  @ApiOperation({
    summary: 'Criar nova contagem de estoque',
    description: 'Cria uma contagem de estoque com os produtos. Use o mesmo contagem_cuid para agrupar contagens relacionadas (tipos 1, 2, 3).'
  })
  @ApiCreatedResponse({
    description: 'Contagem criada com sucesso',
    type: ContagemResponseDto
  })
  @ApiBadRequestResponse({
    description: 'Dados inválidos fornecidos',
    example: {
      statusCode: 400,
      message: ['colaborador não deve estar vazio'],
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async createContagem(@Body() createContagemDto: CreateContagemDto): Promise<ContagemResponseDto> {
    return await this.service.createContagem(createContagemDto);
  }

  @Put('liberar')
  @ApiOperation({
    summary: 'Liberar próxima contagem de um grupo',
    description: 'Libera a próxima contagem de um grupo: se contagem=1 libera tipo 2, se contagem=2 libera tipo 3'
  })
  @ApiOkResponse({
    description: 'Contagem liberada com sucesso',
    example: {
      id: 'clx1234567890abcdef',
      contagem_cuid: 'clx1234567890group',
      contagem: 2,
      liberado_contagem: true
    }
  })
  @ApiBadRequestResponse({
    description: 'Contagem não encontrada ou dados inválidos',
    example: {
      statusCode: 400,
      message: 'Nenhuma contagem encontrada com contagem_cuid "grupo123" e tipo 2',
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async updateLiberadoContagem(@Body() body: UpdateLiberadoContagemDto) {
    return this.service.updateLiberadoContagem(body.contagem_cuid, Number(body.contagem), !!body.divergencia, body.itensParaRevalidar);
  }

  @Put('item/:id')
  @ApiOperation({
    summary: 'Atualizar campo conferir de um item de contagem',
    description: 'Atualiza o campo booleano `conferir` de um item específico de contagem'
  })
  @ApiParam({
    name: 'id',
    description: 'ID do item de contagem a ser atualizado',
    example: 'clx1111222233334444',
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Item atualizado com sucesso',
    example: {
      id: 'clx1111222233334444',
      conferir: true
    }
  })
  @ApiBadRequestResponse({
    description: 'ID do item inválido ou dados do body inválidos',
    example: {
      statusCode: 400,
      message: 'Item não encontrado',
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async updateItemConferir(@Param('id') id: string, @Body() body: UpdateConferirDto) {
    return this.service.updateItemConferir(id, body.conferir, body.itemId);
  }

  @Get('conferir/:cod_produto')
  @ApiOperation({
    summary: 'Consultar estoque de um produto específico',
    description: 'Retorna o estoque disponível de um produto usando consulta OPENQUERY ao sistema ERP'
  })
  @ApiParam({
    name: 'cod_produto',
    description: 'Código do produto a ser consultado',
    example: '23251',
    type: 'number'
  })
  @ApiQuery({
    name: 'empresa',
    description: 'Código da empresa',
    example: '3',
    required: false,
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Estoque do produto retornado com sucesso',
    type: ConferirEstoqueResponseDto,
    example: {
      pro_codigo: 23251,
      ESTOQUE: 15
    }
  })
  @ApiBadRequestResponse({
    description: 'Código do produto inválido ou empresa inválida',
    example: {
      statusCode: 400,
      message: 'Empresa inválida',
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async getEstoqueProduto(
    @Param('cod_produto') codProduto: string,
    @Query('empresa') empresa?: string
  ): Promise<ConferirEstoqueResponseDto | null> {
    const codProdutoNum = parseInt(codProduto, 10);
    if (isNaN(codProdutoNum)) {
      throw new BadRequestException('Código do produto deve ser um número válido');
    }
    return this.service.getEstoqueProduto(codProdutoNum, empresa);
  }

  @Get('logs-agregados/:id')
  @ApiOperation({
    summary: 'Buscar logs agregados de uma contagem',
    description: 'Retorna TODOS os logs associados aos itens desta contagem, cruzando pelo identificador_item. Isso permite ver dados de contagens irmãs (mesmo produto, usuários diferentes) mesmo que tenham CUIDs diferentes.'
  })
  @ApiParam({
    name: 'id',
    description: 'ID da contagem',
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Logs agregados retornados com sucesso'
  })
  async getLogsAgregados(@Param('id') id: string) {
    return this.service.getLogsAgregadosPorContagem(id);
  }

  @Post('log')
  @ApiOperation({
    summary: 'Criar ou atualizar log de contagem',
    description: 'Registra um log da contagem física. Se já existir um log para o mesmo item e contagem, substitui o registro anterior pelos novos dados.'
  })
  @ApiCreatedResponse({
    description: 'Log de contagem criado ou atualizado com sucesso',
    type: LogResponseDto,
    example: {
      id: 'clx5555666677778888',
      contagem_id: 'clx1234567890abcdef',
      usuario_id: 'clx0987654321fedcba',
      item_id: 'clx1111222233334444',
      estoque: 100,
      contado: 95,
      created_at: '2025-11-10T13:30:00.000Z'
    }
  })
  @ApiBadRequestResponse({
    description: 'Dados inválidos fornecidos',
    example: {
      statusCode: 400,
      message: ['contagem_id não deve estar vazio'],
      error: 'Bad Request'
    }
  })
  @ApiInternalServerErrorResponse({
    description: 'Erro interno do servidor',
    example: {
      statusCode: 500,
      message: 'Erro interno do servidor'
    }
  })
  async createLog(@Body() createLogDto: CreateLogDto): Promise<LogResponseDto> {
    return await this.service.createLog(createLogDto);
  }

  @Get('logs/:contagem_id')
  @ApiOperation({
    summary: 'Listar logs de uma contagem',
    description: 'Retorna todos os logs de contagem para um ID de contagem específico, incluindo detalhes do item (localização) e usuário.'
  })
  @ApiParam({
    name: 'contagem_id',
    description: 'ID da contagem',
    example: 'clx1234567890abcdef',
    type: 'string'
  })
  @ApiOkResponse({
    description: 'Lista de logs retornada com sucesso',
    type: LogResponseDto,
    isArray: true
  })
  async getLogsByContagem(@Param('contagem_id') contagemId: string) {
    const logs = await this.service.getLogsByContagem(contagemId);
    return { logs }; // Wrap in object to match frontend expectation { logs: [] }
  }
}
