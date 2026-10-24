import { Injectable } from '@nestjs/common';
import { OpenQueryService } from '../../../shared/database/openquery/openquery.service';
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
const LIMITE_PRODUTOS = 5_000;

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const OPF_RX = /^[A-Za-z0-9]{1,10}$/;

/**
 * OPENQUERY exige string literal, então os valores entram inline. Por isso
 * só passam inteiros, datas YYYY-MM-DD e códigos de operação alfanuméricos.
 */
function inteiros(valores: number[]): string {
  return valores
    .map((v) => {
      if (!Number.isSafeInteger(v)) throw new Error(`Valor inválido para OPENQUERY: ${v}`);
      return String(v);
    })
    .join(',');
}

function textos(valores: string[]): string {
  return valores
    .map((v) => {
      if (!OPF_RX.test(v)) throw new Error(`Código inválido para OPENQUERY: ${v}`);
      return `'${v}'`;
    })
    .join(',');
}

function data(v: string): string {
  if (!DATE_RX.test(v)) throw new Error(`Data inválida para OPENQUERY: ${v}`);
  return `'${v}'`;
}

const SELECT_NOTA = [
  'SELECT',
  '    NFS.NFS AS NFS,',
  '    NFS.DT_EMISSAO AS DT_EMISSAO,',
  '    NFS.STATUS AS STATUS,',
  '    NFS.DT_CANCELAMENTO AS DT_CANCELAMENTO,',
  '    NFS.TOTAL_NOTA AS TOTAL_NOTA,',
  '    TRIM(NFS.OPF_CODIGO) AS OPF_CODIGO,',
  '    TRIM(OPF.OPF_DESCRICAO) AS OPF_DESCRICAO,',
  '    CLI.CLI_NOME AS CLIENTE',
  'FROM NF_SAIDA NFS',
  'LEFT JOIN OPERACOES_FISCAIS OPF ON OPF.EMPRESA = NFS.EMPRESA AND OPF.OPF_CODIGO = NFS.OPF_CODIGO',
  'LEFT JOIN CLIENTES CLI ON CLI.EMPRESA = NFS.EMPRESA AND CLI.CLI_CODIGO = NFS.CLI_CODIGO',
];

const SELECT_PRODUTO = [
  'SELECT',
  '    PRO.PRO_CODIGO AS PRO_CODIGO,',
  '    PRO.PRO_DESCRICAO AS PRO_DESCRICAO,',
  '    PRO.REF_FABRICANTE AS REF_FABRICANTE,',
  '    PRO.UNIDADE AS UNIDADE,',
  '    PRO.LOCALIZACAO AS LOCALIZACAO,',
  '    CAST(SUBSTRING(PRO.APLICACOES FROM 1 FOR 1000) AS VARCHAR(1000)) AS APLICACOES,',
  '    PRO.ESTOQUE_DISPONIVEL AS ESTOQUE_DISPONIVEL,',
  '    PRO.ESTOQUE_RESERVADO AS ESTOQUE_RESERVADO,',
  '    PRO.SUBGRP_CODIGO AS SUBGRP_CODIGO,',
  '    SUB.SUBGRP_DESCRICAO AS SUBGRP_DESCRICAO,',
  '    GRP.GRP_CODIGO AS GRP_CODIGO,',
  '    GRP.GRP_DESCRICAO AS GRP_DESCRICAO,',
  '    MC.MAR_DESCRICAO AS MAR_DESCRICAO',
  'FROM PRODUTOS PRO',
  'LEFT JOIN PRODUTOS_SUBGRUPOS SUB ON SUB.EMPRESA = PRO.EMPRESA AND SUB.SUBGRP_CODIGO = PRO.SUBGRP_CODIGO',
  'LEFT JOIN PRODUTOS_GRUPOS GRP ON GRP.EMPRESA = SUB.EMPRESA AND GRP.GRP_CODIGO = SUB.GRP_CODIGO',
  'LEFT JOIN MARCAS MC ON MC.EMPRESA = PRO.EMPRESA AND MC.MAR_CODIGO = PRO.MAR_CODIGO',
];

/** Fallback: OPENQUERY pelo linked server CONSULTA (dialeto Firebird). */
@Injectable()
export class OpenQueryConciliacaoFonte implements ConciliacaoFonte {
  readonly nome = 'openquery' as const;

  constructor(private readonly oq: OpenQueryService) {}

  private async consultar<T>(linhas: string[], rotulo: string): Promise<T[]> {
    const innerEscaped = linhas.join('\n').replace(/'/g, "''");
    const outerSql = `
      /* conciliacao ${rotulo} OPENQUERY */
      SELECT *
      FROM OPENQUERY(CONSULTA, '${innerEscaped}');
    `;
    return this.oq.query<T>(outerSql, {}, { timeout: 300_000 });
  }

  grupos(): Promise<GrupoRow[]> {
    return this.consultar<GrupoRow>(
      [
        'SELECT GRP.GRP_CODIGO AS GRP_CODIGO, GRP.GRP_DESCRICAO AS GRP_DESCRICAO',
        'FROM PRODUTOS_GRUPOS GRP',
        `WHERE GRP.EMPRESA = ${EMPRESA_GERENCIAL}`,
        'ORDER BY GRP.GRP_DESCRICAO',
      ],
      'grupos',
    );
  }

  subgrupos(): Promise<SubgrupoRow[]> {
    return this.consultar<SubgrupoRow>(
      [
        'SELECT SUB.SUBGRP_CODIGO AS SUBGRP_CODIGO, SUB.SUBGRP_DESCRICAO AS SUBGRP_DESCRICAO,',
        '    SUB.GRP_CODIGO AS GRP_CODIGO, GRP.GRP_DESCRICAO AS GRP_DESCRICAO',
        'FROM PRODUTOS_SUBGRUPOS SUB',
        'LEFT JOIN PRODUTOS_GRUPOS GRP ON GRP.EMPRESA = SUB.EMPRESA AND GRP.GRP_CODIGO = SUB.GRP_CODIGO',
        `WHERE SUB.EMPRESA = ${EMPRESA_GERENCIAL}`,
        'ORDER BY SUB.SUBGRP_DESCRICAO',
      ],
      'subgrupos',
    );
  }

  operacoes(): Promise<OperacaoRow[]> {
    return this.consultar<OperacaoRow>(
      [
        'SELECT TRIM(OPF.OPF_CODIGO) AS OPF_CODIGO, TRIM(OPF.OPF_DESCRICAO) AS OPF_DESCRICAO, OPF.CFOP AS CFOP',
        'FROM OPERACOES_FISCAIS OPF',
        `WHERE OPF.EMPRESA = ${EMPRESA_GERENCIAL}`,
        "    AND (OPF.INATIVO IS NULL OR TRIM(OPF.INATIVO) <> 'S')",
        'ORDER BY 1',
      ],
      'operacoes',
    );
  }

  notasPorNfs(nfs: number[]): Promise<NotaRow[]> {
    return porLotes(nfs, (lote) =>
      this.consultar<NotaRow>(
        [...SELECT_NOTA, `WHERE NFS.EMPRESA = ${EMPRESA_GERENCIAL}`, `    AND NFS.NFS IN (${inteiros(lote)})`],
        'notas-nfs',
      ),
    );
  }

  async notasPorPeriodo(f: FiltroNotas): Promise<NotaRow[]> {
    const linhas = [...SELECT_NOTA];
    linhas[0] = `SELECT FIRST ${LIMITE_NOTAS + 1}`;
    const rows = await this.consultar<NotaRow>(
      [
        ...linhas,
        `WHERE NFS.EMPRESA = ${EMPRESA_GERENCIAL}`,
        `    AND NFS.DT_EMISSAO BETWEEN ${data(f.data_inicial)} AND ${data(f.data_final)}`,
        `    AND TRIM(NFS.OPF_CODIGO) IN (${textos(f.operacoes)})`,
        '    AND NFS.DT_CANCELAMENTO IS NULL',
        '    AND NFS.STATUS <> 3',
        'ORDER BY NFS.DT_EMISSAO, NFS.NFS',
      ],
      'notas-periodo',
    );
    if (rows.length > LIMITE_NOTAS) {
      throw new LimiteExcedidoError(`Mais de ${LIMITE_NOTAS} notas no filtro. Reduza o período ou as operações.`);
    }
    return rows;
  }

  itensDasNotas(nfs: number[]): Promise<ItemNotaRow[]> {
    return porLotes(nfs, (lote) =>
      this.consultar<ItemNotaRow>(
        [
          'SELECT I.NFS AS NFS, I.PRO_CODIGO AS PRO_CODIGO, I.QUANTIDADE AS QUANTIDADE,',
          '    I.QTDE_DEVOLVIDA AS QTDE_DEVOLVIDA, TRIM(NFS.OPF_CODIGO) AS OPF_CODIGO',
          'FROM NFS_ITENS I',
          'LEFT JOIN NF_SAIDA NFS ON NFS.EMPRESA = I.EMPRESA AND NFS.NFS = I.NFS',
          `WHERE I.EMPRESA = ${EMPRESA_GERENCIAL}`,
          `    AND I.NFS IN (${inteiros(lote)})`,
        ],
        'itens',
      ),
    );
  }

  async produtosGerencial(f: FiltroProdutos): Promise<ProdutoRow[]> {
    if (f.codigos?.length) {
      return porLotes(f.codigos, (lote) =>
        this.consultar<ProdutoRow>(
          [...SELECT_PRODUTO, `WHERE PRO.EMPRESA = ${EMPRESA_GERENCIAL}`, `    AND PRO.PRO_CODIGO IN (${inteiros(lote)})`],
          'produtos-codigos',
        ),
      );
    }

    const taxonomia: string[] = [];
    if (f.subgrupos?.length) taxonomia.push(`PRO.SUBGRP_CODIGO IN (${inteiros(f.subgrupos)})`);
    if (f.grupos?.length) taxonomia.push(`GRP.GRP_CODIGO IN (${inteiros(f.grupos)})`);
    if (!taxonomia.length) return [];

    // Mesma paginação da fonte api, para não depender de um SELECT gigante.
    const saida: ProdutoRow[] = [];
    let ultimo = -1;
    for (;;) {
      const linhas = [...SELECT_PRODUTO];
      linhas[0] = `SELECT FIRST ${LIMITE_PRODUTOS}`;
      const rows = await this.consultar<ProdutoRow>(
        [
          ...linhas,
          `WHERE PRO.EMPRESA = ${EMPRESA_GERENCIAL}`,
          `    AND (${taxonomia.join(' OR ')})`,
          `    AND PRO.PRO_CODIGO > ${inteiros([ultimo])}`,
          'ORDER BY PRO.PRO_CODIGO',
        ],
        'produtos-taxonomia',
      );
      saida.push(...rows);
      if (rows.length < LIMITE_PRODUTOS) return saida;
      ultimo = Number(rows[rows.length - 1].PRO_CODIGO);
    }
  }

  saldosFiscal(codigos: number[]): Promise<SaldoRow[]> {
    return porLotes(codigos, (lote) =>
      this.consultar<SaldoRow>(
        [
          'SELECT PRO.PRO_CODIGO AS PRO_CODIGO, PRO.ESTOQUE_DISPONIVEL AS ESTOQUE_DISPONIVEL,',
          '    PRO.ESTOQUE_RESERVADO AS ESTOQUE_RESERVADO',
          'FROM PRODUTOS PRO',
          `WHERE PRO.EMPRESA = ${EMPRESA_FISCAL}`,
          `    AND PRO.PRO_CODIGO IN (${inteiros(lote)})`,
        ],
        'saldos-fiscal',
      ),
    );
  }
}
