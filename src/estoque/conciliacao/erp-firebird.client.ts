import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface ErpConsultaResposta<T> {
  dados: T[];
  meta: { linhas: number; truncado?: boolean; ms?: number };
}

/**
 * Cliente da api-firebird-service (leitura direta do Firebird do ERP).
 * Envs: ERP_FIREBIRD_URL, ERP_FIREBIRD_TOKEN e ERP_FIREBIRD_TIMEOUT_MS (default 15000).
 */
@Injectable()
export class ErpFirebirdClient {
  private readonly http?: AxiosInstance;

  constructor(config: ConfigService) {
    const baseURL = String(config.get('ERP_FIREBIRD_URL') ?? '').trim().replace(/\/+$/, '');
    if (!baseURL) return;

    const headers: Record<string, string> = { 'x-servico': 'estoque-service' };
    const token = config.get<string>('ERP_FIREBIRD_TOKEN');
    if (token) headers['x-app-token'] = token;

    this.http = axios.create({
      baseURL,
      headers,
      timeout: Number(config.get('ERP_FIREBIRD_TIMEOUT_MS') ?? 15_000),
    });
  }

  get configurado(): boolean {
    return !!this.http;
  }

  /** POST /erp/<recurso>/consulta */
  async consultar<T>(recurso: string, corpo: Record<string, any>): Promise<ErpConsultaResposta<T>> {
    if (!this.http) throw new Error('ERP_FIREBIRD_URL não configurada');
    const { data } = await this.http.post<ErpConsultaResposta<T>>(`/erp/${recurso}/consulta`, corpo);
    if (!data || !Array.isArray(data.dados)) {
      throw new Error(`Resposta inesperada de /erp/${recurso}/consulta`);
    }
    return data;
  }
}
