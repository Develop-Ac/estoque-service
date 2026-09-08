import { Injectable } from '@nestjs/common';
import { EstoqueSaidasRepository } from './contagem.repository';
import { EstoqueSaidaRow } from './contagem.types';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ContagemResponseDto } from './dto/contagem-response.dto';
import { ConferirEstoqueResponseDto } from './dto/conferir-estoque-response.dto';
import { CreateLogDto } from './dto/create-log.dto';
import { LogResponseDto } from './dto/log-response.dto';
import { UpdateGrupoContagemDto } from './dto/update-grupo-contagem.dto';

@Injectable()
export class EstoqueSaidasService {
  constructor(private readonly repo: EstoqueSaidasRepository) { }

  async listarSaidas(filters: {
    data_inicial: string;
    data_final: string;
    empresa: string;
    tipo?: number;
  }): Promise<EstoqueSaidaRow[]> {
    return this.repo.fetchSaidas(filters);
  }

  // ===== CONTAGEM AVULSA =====
  async buscarProdutosPorFiltro(filters: {
    empresa: string;
    cod_produto?: number;
    cod_produtos?: number[];
    marca?: number;
    descricao?: string;
    grupo?: number;
    subgrupo?: number;
    somente_com_saldo?: boolean;
    piso?: string;
    prateleira?: number;
    pisos?: string[];
    prateleiras?: number[];
    colunas?: number[];
  }): Promise<EstoqueSaidaRow[]> {
    return this.repo.fetchProdutosPorFiltro(filters);
  }

  /** Itens pendentes de outras contagens avulsas, disponíveis para adoção. */
  async listarItensPendentes() {
    return this.repo.getItensPendentes();
  }

  /** Prateleiras existentes no(s) piso(s) informado(s) (filtro-filho da avulsa). */
  async listarPrateleiras(empresa: string, piso: string) {
    return this.repo.fetchPrateleirasPorPiso(empresa, piso);
  }

  /** Colunas (prédio) existentes nos pisos/prateleiras (3º nível do filtro encadeado). */
  async listarColunas(empresa: string, piso: string, prateleira?: string) {
    return this.repo.fetchColunasPorFiltro(empresa, piso, prateleira);
  }

  async listarGrupos(empresa: string) {
    return this.repo.fetchGrupos(empresa);
  }

  async listarSubgrupos(empresa: string, grupo?: number) {
    return this.repo.fetchSubgrupos(empresa, grupo);
  }

  async listarMarcas(empresa: string) {
    return this.repo.fetchMarcas(empresa);
  }

  async createContagem(createContagemDto: CreateContagemDto): Promise<ContagemResponseDto> {
    try {
      const result = await this.repo.createContagem(createContagemDto);

      // Auditoria é acessória: a contagem já está gravada — falha no log-service
      // não pode transformar a criação num erro para quem chamou.
      try {
        await fetch('http://log-service.acacessorios.local/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usuario: createContagemDto.usuario,
            setor: 'Compras',
            tela: 'Comparativo',
            acao: 'Create',
            descricao: `Criou contagem do colaborador ${createContagemDto.colaborador} com ${createContagemDto.produtos.length} produtos.`,
          }),
        });
      } catch (logError) {
        console.error('Falha ao registrar auditoria da contagem no log-service:', logError);
      }

      return result;
    } catch (error) {
      console.error('Error creating contagem:', error);
      throw error;
    }
  }

  async getContagensByUsuario(idUsuario: string): Promise<ContagemResponseDto[]> {
    const result = await this.repo.getContagensByUsuario(idUsuario);
    return result.map(contagem => ({
      ...contagem,
      itens: contagem.itens.map(item => ({
        ...item,
        contagem_id: item.contagem_cuid,
      }))
    }));
  }

  async updateItemConferir(identificador_item: string, conferir: boolean, itemId: string) {
    return this.repo.updateItemConferir(identificador_item, conferir, itemId,);
  }

  async getEstoqueProduto(codProduto: number, empresa?: string): Promise<ConferirEstoqueResponseDto | null> {
    return this.repo.getEstoqueProduto(codProduto, empresa);
  }

  /** Saldo de vários produtos numa consulta em lote (mapa código -> estoque). */
  async getEstoquePorProdutos(codigos: number[], empresa?: string): Promise<Map<number, number>> {
    return this.repo.getEstoquePorProdutos(codigos, empresa);
  }

  async updateLiberadoContagem(contagem_cuid: string, contagem: number, divergencia: boolean, itensParaRevalidar?: string[], data_fim?: string) {
    return this.repo.updateLiberadoContagem(contagem_cuid, contagem, divergencia, itensParaRevalidar, data_fim);
  }

  async getContagensByGrupo(contagem_cuid: string): Promise<ContagemResponseDto[]> {
    const result = await this.repo.getContagensByGrupo(contagem_cuid);
    return result.map(contagem => ({
      ...contagem,
      itens: contagem.itens.map(item => ({
        ...item,
        contagem_id: item.contagem_cuid,
      }))
    }));
  }

  async getAllContagens(params?: { page?: number; pageSize?: number; data?: string; piso?: string; tipo?: number }) {
    return this.repo.getAllContagens(params);
  }

  async deleteContagem(id: string) {
    return this.repo.deleteContagem(id);
  }

  async updateContagemGrupo(contagemCuid: string, data: UpdateGrupoContagemDto) {
    return this.repo.updateContagemGrupo(contagemCuid, data);
  }

  async getLogsAgregadosPorContagem(contagemId: string) {
    return this.repo.getLogsAgregadosPorContagem(contagemId);
  }

  async createLog(createLogDto: CreateLogDto): Promise<LogResponseDto> {
    return this.repo.createLog(createLogDto);
  }

  async getLogsByContagem(contagemId: string) {
    return this.repo.getLogsByContagem(contagemId);
  }
}
