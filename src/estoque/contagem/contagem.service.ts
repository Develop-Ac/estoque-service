import { Injectable } from '@nestjs/common';
import { EstoqueSaidasRepository } from './contagem.repository';
import { EstoqueSaidaRow } from './contagem.types';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ContagemResponseDto } from './dto/contagem-response.dto';
import { ConferirEstoqueResponseDto } from './dto/conferir-estoque-response.dto';
import { CreateLogDto } from './dto/create-log.dto';
import { LogResponseDto } from './dto/log-response.dto';

@Injectable()
export class EstoqueSaidasService {
  constructor(private readonly repo: EstoqueSaidasRepository) { }

  async listarSaidas(filters: {
    data_inicial: string;
    data_final: string;
    empresa: string;
  }): Promise<EstoqueSaidaRow[]> {
    return this.repo.fetchSaidas(filters);
  }

  async createContagem(createContagemDto: CreateContagemDto): Promise<ContagemResponseDto> {
    return this.repo.createContagem(createContagemDto);
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

  async updateLiberadoContagem(contagem_cuid: string, contagem: number, divergencia: boolean, itensParaRevalidar?: string[]) {
    return this.repo.updateLiberadoContagem(contagem_cuid, contagem, divergencia, itensParaRevalidar);
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

  async getAllContagens(): Promise<ContagemResponseDto[]> {
    return this.repo.getAllContagens();
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
