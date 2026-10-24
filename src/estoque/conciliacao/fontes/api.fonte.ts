import { Injectable } from '@nestjs/common';
import { ErpApiService } from '../../../shared/erp-api/erp-api.service';
import {
  ConciliacaoFonte,
  EMPRESA_FISCAL,
  EMPRESA_GERENCIAL,
  FiltroNotas,
  FiltroProdutos,
  GrupoRow,
  ItemNotaRow,
  NotaRow,
  OperacaoRow,
  ProdutoRow,
  SaldoRow,
  SubgrupoRow,
} from '../conciliacao.types';
import { LimiteExcedidoError, porLotes } from './lotes';

const LIMITE_NOTAS = 20_000;
const LIMITE_ITENS = 50_000;
const LIMITE_PRODUTOS = 5_000;

const CAMPOS_NOTA = [
  'NFS',
  'DT_EMISSAO',
  'STATUS',
  'DT_CANCELAMENTO',
  'TOTAL_NOTA',
  'OPF_CODIGO',
  { campo: 'operacao.OPF_DESCRICAO', como: 'OPF_DESCRICAO' },
  { campo: 'cliente.CLI_NOME', como: 'CLIENTE' },
];

const CAMPOS_PRODUTO = [
  'PRO_CODIGO',
  'PRO_DESCRICAO',
  'REF_FABRICANTE',
  'UNIDADE',
  'LOCALIZACAO',
  'APLICACOES',
  'ESTOQUE_DISPONIVEL',
  'ESTOQUE_RESERVADO',
  'SUBGRP_CODIGO',
  { campo: 'subgrupo.SUBGRP_DESCRICAO', como: 'SUBGRP_DESCRICAO' },
  { campo: 'grupo.GRP_CODIGO', como: 'GRP_CODIGO' },
  { campo: 'grupo.GRP_DESCRICAO', como: 'GRP_DESCRICAO' },
  { campo: 'marca.MAR_DESCRICAO', como: 'MAR_DESCRICAO' },
];

/** Fonte principal: erp-firebird-api. */
@Injectable()
export class ApiConciliacaoFonte implements ConciliacaoFonte {
  readonly nome = 'api' as const;

  constructor(private readonly erp: ErpApiService) {}

  async grupos(): Promise<GrupoRow[]> {
    const r = await this.erp.consultar<GrupoRow>('produtos-grupos', {
      empresa: EMPRESA_GERENCIAL,
      campos: ['GRP_CODIGO', 'GRP_DESCRICAO'],
      ordenar: [{ campo: 'GRP_DESCRICAO' }],
      limite: 5000,
    });
    return r.dados;
  }

  async subgrupos(): Promise<SubgrupoRow[]> {
    const r = await this.erp.consultar<SubgrupoRow>('produtos-subgrupos', {
      empresa: EMPRESA_GERENCIAL,
      campos: ['SUBGRP_CODIGO', 'SUBGRP_DESCRICAO', 'GRP_CODIGO', { campo: 'grupo.GRP_DESCRICAO', como: 'GRP_DESCRICAO' }],
      ordenar: [{ campo: 'SUBGRP_DESCRICAO' }],
      limite: 5000,
    });
    return r.dados;
  }

  async operacoes(): Promise<OperacaoRow[]> {
    const r = await this.erp.consultar<OperacaoRow>('operacoes-fiscais', {
      empresa: EMPRESA_GERENCIAL,
      campos: ['OPF_CODIGO', 'OPF_DESCRICAO', 'CFOP'],
      filtros: [{ ou: [{ campo: 'INATIVO', op: 'nulo' }, { campo: 'INATIVO', op: 'diferente', valor: 'S' }] }],
      ordenar: [{ campo: 'OPF_CODIGO' }],
      limite: 2000,
    });
    return r.dados;
  }

  async notasPorNfs(nfs: number[]): Promise<NotaRow[]> {
    return porLotes(nfs, async (lote) => {
      const r = await this.erp.consultar<NotaRow>('nf-saida', {
        empresa: EMPRESA_GERENCIAL,
        campos: CAMPOS_NOTA,
        filtros: [{ campo: 'NFS', op: 'em', valor: lote }],
        limite: lote.length,
      });
      return r.dados;
    });
  }

  async notasPorPeriodo(f: FiltroNotas): Promise<NotaRow[]> {
    const r = await this.erp.consultar<NotaRow>('nf-saida', {
      empresa: EMPRESA_GERENCIAL,
      campos: CAMPOS_NOTA,
      filtros: [
        { campo: 'DT_EMISSAO', op: 'entre', valor: [f.data_inicial, f.data_final] },
        { campo: 'OPF_CODIGO', op: 'em', valor: f.operacoes },
        { campo: 'DT_CANCELAMENTO', op: 'nulo' },
        { campo: 'STATUS', op: 'diferente', valor: 3 },
      ],
      ordenar: [{ campo: 'DT_EMISSAO' }, { campo: 'NFS' }],
      limite: LIMITE_NOTAS,
    });
    if (r.meta?.truncado) {
      throw new LimiteExcedidoError(`Mais de ${LIMITE_NOTAS} notas no filtro. Reduza o período ou as operações.`);
    }
    return r.dados;
  }

  async itensDasNotas(nfs: number[]): Promise<ItemNotaRow[]> {
    return porLotes(nfs, async (lote) => {
      const r = await this.erp.consultar<ItemNotaRow>('nfs-itens', {
        empresa: EMPRESA_GERENCIAL,
        campos: ['NFS', 'PRO_CODIGO', 'QUANTIDADE', 'QTDE_DEVOLVIDA', { campo: 'nota.OPF_CODIGO', como: 'OPF_CODIGO' }],
        filtros: [{ campo: 'NFS', op: 'em', valor: lote }],
        limite: LIMITE_ITENS,
      });
      if (r.meta?.truncado) {
        throw new LimiteExcedidoError(`Mais de ${LIMITE_ITENS} itens em um lote de notas. Selecione menos notas.`);
      }
      return r.dados;
    });
  }

  async produtosGerencial(f: FiltroProdutos): Promise<ProdutoRow[]> {
    if (f.codigos?.length) {
      return porLotes(f.codigos, async (lote) => {
        const r = await this.erp.consultar<ProdutoRow>('produtos', {
          empresa: EMPRESA_GERENCIAL,
          campos: CAMPOS_PRODUTO,
          filtros: [{ campo: 'PRO_CODIGO', op: 'em', valor: lote }],
          limite: lote.length,
        });
        return r.dados;
      });
    }

    const taxonomia: any[] = [];
    if (f.subgrupos?.length) taxonomia.push({ campo: 'SUBGRP_CODIGO', op: 'em', valor: f.subgrupos });
    if (f.grupos?.length) taxonomia.push({ campo: 'grupo.GRP_CODIGO', op: 'em', valor: f.grupos });
    if (!taxonomia.length) return [];

    // Grupo grande passa do limite da tabela: pagina por PRO_CODIGO crescente.
    const saida: ProdutoRow[] = [];
    let ultimo = -1;
    for (;;) {
      const r = await this.erp.consultar<ProdutoRow>('produtos', {
        empresa: EMPRESA_GERENCIAL,
        campos: CAMPOS_PRODUTO,
        filtros: [{ ou: taxonomia }, { campo: 'PRO_CODIGO', op: 'maior', valor: ultimo }],
        ordenar: [{ campo: 'PRO_CODIGO' }],
        limite: LIMITE_PRODUTOS,
      });
      saida.push(...r.dados);
      if (r.dados.length < LIMITE_PRODUTOS) return saida;
      ultimo = Number(r.dados[r.dados.length - 1].PRO_CODIGO);
    }
  }

  async saldosFiscal(codigos: number[]): Promise<SaldoRow[]> {
    return porLotes(codigos, async (lote) => {
      const r = await this.erp.consultar<SaldoRow>('produtos', {
        empresa: EMPRESA_FISCAL,
        campos: ['PRO_CODIGO', 'ESTOQUE_DISPONIVEL', 'ESTOQUE_RESERVADO'],
        filtros: [{ campo: 'PRO_CODIGO', op: 'em', valor: lote }],
        limite: lote.length,
      });
      return r.dados;
    });
  }
}
