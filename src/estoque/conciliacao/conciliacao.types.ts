// Conciliação de estoque: empresa 1 (fiscal) × empresa 3 (gerencial, a auditada).

export type FonteDados = 'api' | 'openquery';

export const EMPRESA_FISCAL = 1;
export const EMPRESA_GERENCIAL = 3;

export interface GrupoRow {
  GRP_CODIGO: number;
  GRP_DESCRICAO: string | null;
}

export interface SubgrupoRow {
  SUBGRP_CODIGO: number;
  SUBGRP_DESCRICAO: string | null;
  GRP_CODIGO: number | null;
  GRP_DESCRICAO: string | null;
}

export interface OperacaoRow {
  OPF_CODIGO: string;
  OPF_DESCRICAO: string | null;
  CFOP: string | null;
}

/** Cabeçalho de NF_SAIDA da empresa 3 (venda ou nota de saída). */
export interface NotaRow {
  NFS: number;
  DT_EMISSAO: string | Date | null;
  STATUS: number | null;
  DT_CANCELAMENTO: string | Date | null;
  TOTAL_NOTA: number | null;
  OPF_CODIGO: string | null;
  OPF_DESCRICAO: string | null;
  CLIENTE: string | null;
}

export interface ItemNotaRow {
  NFS: number;
  PRO_CODIGO: number;
  QUANTIDADE: number | null;
  QTDE_DEVOLVIDA: number | null;
  OPF_CODIGO: string | null;
}

/** Produto da empresa 3, com o cadastro completo. */
export interface ProdutoRow {
  PRO_CODIGO: number;
  PRO_DESCRICAO: string | null;
  REF_FABRICANTE: string | null;
  UNIDADE: string | null;
  LOCALIZACAO: string | null;
  APLICACOES: string | null;
  ESTOQUE_DISPONIVEL: number | null;
  ESTOQUE_RESERVADO: number | null;
  SUBGRP_CODIGO: number | null;
  SUBGRP_DESCRICAO: string | null;
  GRP_CODIGO: number | null;
  GRP_DESCRICAO: string | null;
  MAR_DESCRICAO: string | null;
}

/** Só o saldo, para a empresa 1. */
export interface SaldoRow {
  PRO_CODIGO: number;
  ESTOQUE_DISPONIVEL: number | null;
  ESTOQUE_RESERVADO: number | null;
}

/** Lançamento do kardex (LANCTOS_ESTOQUE) como as fontes devolvem. */
export interface KardexRow {
  LANCTO: number | string;
  DATA: string | Date;
  HORA_SERVIDOR: string | Date | null;
  ORIGEM: string | null;
  OPERACAO: string | null;
  TIPO_ESTOQUE: number | null;
  QUANTIDADE: number | string | null;
  NFS: number | null;
  NFS_ITEM: number | null;
  NFE: number | null;
  NFE_ITEM: number | null;
  CONDICIONAL: number | null;
  ORDEM_SERVICO: number | null;
  CONTAGEM_ESTOQUE: number | null;
  USU_CODIGO: number | null;
  MAQUINA: string | null;
}

/** Σ QUANTIDADE do kardex inteiro do produto, por OPERACAO ('E'/'S'). */
export interface TotalKardexRow {
  OPERACAO: string | null;
  TOTAL: number | string | null;
}

export interface FiltroProdutos {
  grupos?: number[];
  subgrupos?: number[];
  codigos?: number[];
}

export interface FiltroNotas {
  data_inicial: string;
  data_final: string;
  operacoes: string[];
}

/**
 * De onde vêm os dados do ERP. Duas implementações: a api-firebird-service
 * (principal) e o OPENQUERY pelo linked server (fallback).
 */
export interface ConciliacaoFonte {
  readonly nome: FonteDados;
  grupos(): Promise<GrupoRow[]>;
  subgrupos(): Promise<SubgrupoRow[]>;
  operacoes(): Promise<OperacaoRow[]>;
  notasPorNfs(nfs: number[]): Promise<NotaRow[]>;
  notasPorPeriodo(filtro: FiltroNotas): Promise<NotaRow[]>;
  itensDasNotas(nfs: number[]): Promise<ItemNotaRow[]>;
  produtosGerencial(filtro: FiltroProdutos): Promise<ProdutoRow[]>;
  saldosFiscal(codigos: number[]): Promise<SaldoRow[]>;
  /** Kardex do produto na empresa, ordenado por DATA, LANCTO; `desde` (YYYY-MM-DD) corta por baixo, sem ele vem tudo. */
  kardex(empresa: number, codigo: number, desde?: string): Promise<KardexRow[]>;
  totaisKardex(empresa: number, codigo: number): Promise<TotalKardexRow[]>;
}

export type ModoConciliacao = 'grupo' | 'venda' | 'operacao';

export interface ConciliacaoLinha {
  PRO_CODIGO: number;
  PRO_DESCRICAO: string | null;
  REF_FABRICANTE: string | null;
  MARCA: string | null;
  UNIDADE: string | null;
  GRP_CODIGO: number | null;
  GRP_DESCRICAO: string | null;
  SUBGRP_CODIGO: number | null;
  SUBGRP_DESCRICAO: string | null;
  /** Localização principal e, se houver, a segunda (vinda de APLICACOES). */
  LOCALIZACOES: string[];
  E1_DISPONIVEL: number;
  E1_RESERVADO: number;
  E3_DISPONIVEL: number;
  E3_RESERVADO: number;
  /** (Disp + Res) E3 − (Disp + Res) E1. */
  DIFERENCA: number;
  SEM_CADASTRO_FISCAL: boolean;
  /** Modos venda/operação: quantidade movimentada nas notas selecionadas. */
  QTD_MOVIMENTADA?: number;
  /** Modos venda/operação: NFS em que o produto aparece. */
  NFS?: number[];
  /** Modo operação: operações (OPF_CODIGO) em que o produto aparece. */
  OPERACOES?: string[];
}

export interface ConciliacaoResultado {
  fonte: FonteDados;
  modo: ModoConciliacao;
  itens: ConciliacaoLinha[];
  avisos: string[];
}
