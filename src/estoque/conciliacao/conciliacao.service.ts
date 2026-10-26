import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { formatAndValidateLocation } from '../shared/localizacao';
import { ErpApiService } from '../../shared/erp-api/erp-api.service';
import { ApiConciliacaoFonte } from './fontes/api.fonte';
import { OpenQueryConciliacaoFonte } from './fontes/openquery.fonte';
import { LimiteExcedidoError, TAMANHO_LOTE } from './fontes/lotes';
import { dataIso, numero, numeroOuNull, round, texto } from './normalizar';
import { JANELA_CASAMENTO_DIAS, Rastreio, rastrear } from './rastreio';
import {
  ConciliacaoFonte,
  ConciliacaoLinha,
  ConciliacaoResultado,
  EMPRESA_FISCAL,
  EMPRESA_GERENCIAL,
  FiltroNotas,
  FonteDados,
  GrupoRow,
  ItemNotaRow,
  ModoConciliacao,
  NotaRow,
  OperacaoRow,
  ProdutoRow,
  SaldoRow,
  SubgrupoRow,
  TotalKardexRow,
} from './conciliacao.types';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const OPF_RX = /^[A-Za-z0-9]{1,10}$/;
const MAX_DIAS_PERIODO = 90;
const MAX_VENDAS = 500;
const MAX_NOTAS = 20_000;
const STATUS_CANCELADA = 3;
/** Venda que entra na conciliação: emitida (1) ou autorizada (2). */
const STATUS_VENDA = new Set([1, 2]);

export interface ComFonte<T> {
  fonte: FonteDados;
  itens: T;
}

export interface VendaValidada {
  NFS: number;
  encontrada: boolean;
  cancelada: boolean;
  STATUS: number | null;
  DT_EMISSAO: string | null;
  CLIENTE: string | null;
  TOTAL_NOTA: number | null;
  OPF_CODIGO: string | null;
  OPF_DESCRICAO: string | null;
}

export interface NotaListada {
  NFS: number;
  DT_EMISSAO: string | null;
  STATUS: number | null;
  CLIENTE: string | null;
  TOTAL_NOTA: number | null;
  OPF_CODIGO: string | null;
  OPF_DESCRICAO: string | null;
}

export class ConciliarBody {
  modo?: string;
  grupos?: unknown;
  subgrupos?: unknown;
  nfs?: unknown;
}

/* ------------------------------ normalização ------------------------------ */

/** Aceita array, número ou "1,2,3" e devolve inteiros positivos sem repetição. */
export function lerInteiros(v: unknown, campo: string): number[] {
  if (v == null || v === '') return [];
  const brutos = Array.isArray(v) ? v : String(v).split(',');
  const saida = new Set<number>();
  for (const b of brutos) {
    const s = String(b).trim();
    if (!s) continue;
    if (!/^\d+$/.test(s))
      throw new BadRequestException(`${campo}: "${s}" não é um número inteiro`);
    const n = Number(s);
    if (!Number.isSafeInteger(n))
      throw new BadRequestException(`${campo}: "${s}" fora do intervalo`);
    saida.add(n);
  }
  return [...saida];
}

export function lerOperacoes(v: unknown): string[] {
  if (v == null || v === '') return [];
  const brutos = Array.isArray(v) ? v : String(v).split(',');
  const saida = new Set<string>();
  for (const b of brutos) {
    const s = String(b).trim();
    if (!s) continue;
    if (!OPF_RX.test(s))
      throw new BadRequestException(`operacoes: código "${s}" inválido`);
    saida.add(s);
  }
  return [...saida];
}

export function lerPeriodo(
  data_inicial: unknown,
  data_final: unknown,
): { data_inicial: string; data_final: string } {
  const ini = String(data_inicial ?? '');
  const fim = String(data_final ?? '');
  if (!DATE_RX.test(ini) || !DATE_RX.test(fim)) {
    throw new BadRequestException(
      'data_inicial e data_final devem ser YYYY-MM-DD',
    );
  }
  const dIni = Date.parse(`${ini}T00:00:00Z`);
  const dFim = Date.parse(`${fim}T00:00:00Z`);
  if (isNaN(dIni) || isNaN(dFim))
    throw new BadRequestException('Data inválida');
  if (dFim < dIni)
    throw new BadRequestException('data_final anterior à data_inicial');
  const dias = (dFim - dIni) / 86_400_000 + 1;
  if (dias > MAX_DIAS_PERIODO) {
    throw new BadRequestException(
      `O período pode ter no máximo ${MAX_DIAS_PERIODO} dias`,
    );
  }
  return { data_inicial: ini, data_final: fim };
}

export interface PeriodoRastreio {
  /** null = tudo (desde o primeiro lançamento). */
  data_inicial: string | null;
  data_final: string;
}

export interface RastreioResultado extends Rastreio {
  fonte: FonteDados;
  produto: Pick<
    ConciliacaoLinha,
    | 'PRO_CODIGO'
    | 'PRO_DESCRICAO'
    | 'REF_FABRICANTE'
    | 'MARCA'
    | 'UNIDADE'
    | 'GRP_DESCRICAO'
    | 'SUBGRP_DESCRICAO'
    | 'LOCALIZACOES'
  >;
}

function hojeLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function somarDias(data: string, dias: number): string {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function dataValida(s: string): boolean {
  return DATE_RX.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function lerCodigo(v: unknown): number {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) === 0) {
    throw new BadRequestException('codigo deve ser um número inteiro');
  }
  return Number(s);
}

/** Período do rastreio: padrão 12 meses até hoje; `tudo` ignora as datas. Sem limite de dias. */
export function lerPeriodoRastreio(
  data_inicial: unknown,
  data_final: unknown,
  tudo: unknown,
  hoje = hojeLocal(),
): PeriodoRastreio {
  if (tudo === '1' || tudo === 'true')
    return { data_inicial: null, data_final: hoje };
  const fim = data_final ? String(data_final) : hoje;
  if (!dataValida(fim))
    throw new BadRequestException('data_final deve ser YYYY-MM-DD');
  let ini = data_inicial ? String(data_inicial) : '';
  if (!ini) {
    const d = new Date(`${fim}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    ini = d.toISOString().slice(0, 10);
  }
  if (!dataValida(ini))
    throw new BadRequestException('data_inicial deve ser YYYY-MM-DD');
  if (fim < ini)
    throw new BadRequestException('data_final anterior à data_inicial');
  return { data_inicial: ini, data_final: fim };
}

function totais(rows: TotalKardexRow[]): { entradas: number; saidas: number } {
  const soma = (op: string) =>
    rows
      .filter((r) => (texto(r.OPERACAO) ?? '').toUpperCase() === op)
      .reduce((t, r) => t + numero(r.TOTAL), 0);
  return { entradas: soma('E'), saidas: soma('S') };
}

/* -------------------------------------------------------------------------- */

interface Movimento {
  qtd: number;
  nfs: Set<number>;
  operacoes: Set<string>;
}

@Injectable()
export class ConciliacaoService {
  private readonly logger = new Logger(ConciliacaoService.name);

  constructor(
    private readonly erp: ErpApiService,
    private readonly api: ApiConciliacaoFonte,
    private readonly openquery: OpenQueryConciliacaoFonte,
  ) {}

  /**
   * Roda a operação inteira numa fonte só (nunca mistura as duas): erp-firebird-api
   * quando habilitada; qualquer falha dela refaz tudo pelo OPENQUERY. Filtro grande
   * demais (LimiteExcedidoError) não é falha da fonte: vira 400 sem fallback.
   */
  private async comFonte<T>(
    rotulo: string,
    fn: (fonte: ConciliacaoFonte) => Promise<T>,
  ): Promise<{ fonte: FonteDados; valor: T }> {
    try {
      if (this.erp.habilitado) {
        try {
          return { fonte: this.api.nome, valor: await fn(this.api) };
        } catch (err: any) {
          if (
            err instanceof LimiteExcedidoError ||
            err instanceof BadRequestException
          )
            throw err;
          this.logger.warn(
            `[${rotulo}] erp-firebird-api falhou: ${err?.message || err}. Usando OPENQUERY.`,
          );
        }
      }
      return { fonte: this.openquery.nome, valor: await fn(this.openquery) };
    } catch (err) {
      if (err instanceof LimiteExcedidoError)
        throw new BadRequestException(err.message);
      throw err;
    }
  }

  async grupos(): Promise<ComFonte<GrupoRow[]>> {
    const { fonte, valor } = await this.comFonte('grupos', (f) => f.grupos());
    return {
      fonte,
      itens: valor.map((g) => ({
        GRP_CODIGO: numero(g.GRP_CODIGO),
        GRP_DESCRICAO: texto(g.GRP_DESCRICAO),
      })),
    };
  }

  async subgrupos(grupos: number[]): Promise<ComFonte<SubgrupoRow[]>> {
    const { fonte, valor } = await this.comFonte('subgrupos', (f) =>
      f.subgrupos(),
    );
    const filtro = new Set(grupos);
    return {
      fonte,
      itens: valor
        .map((s) => ({
          SUBGRP_CODIGO: numero(s.SUBGRP_CODIGO),
          SUBGRP_DESCRICAO: texto(s.SUBGRP_DESCRICAO),
          GRP_CODIGO: numeroOuNull(s.GRP_CODIGO),
          GRP_DESCRICAO: texto(s.GRP_DESCRICAO),
        }))
        .filter(
          (s) =>
            !filtro.size || (s.GRP_CODIGO != null && filtro.has(s.GRP_CODIGO)),
        ),
    };
  }

  async operacoes(): Promise<ComFonte<OperacaoRow[]>> {
    const { fonte, valor } = await this.comFonte('operacoes', (f) =>
      f.operacoes(),
    );
    return {
      fonte,
      itens: valor.map((o) => ({
        OPF_CODIGO: texto(o.OPF_CODIGO) ?? '',
        OPF_DESCRICAO: texto(o.OPF_DESCRICAO),
        CFOP: texto(o.CFOP),
      })),
    };
  }

  /** Confere cada NFS digitado: se existe na empresa 3 e se não está cancelado. */
  async validarVendas(nfs: number[]): Promise<ComFonte<VendaValidada[]>> {
    if (!nfs.length) throw new BadRequestException('Informe ao menos um NFS');
    if (nfs.length > MAX_VENDAS)
      throw new BadRequestException(`No máximo ${MAX_VENDAS} vendas por vez`);

    const { fonte, valor } = await this.comFonte('vendas', (f) =>
      f.notasPorNfs(nfs),
    );
    const porNfs = new Map(valor.map((n) => [numero(n.NFS), n]));
    return {
      fonte,
      itens: nfs.map((codigo) => {
        const n = porNfs.get(codigo);
        if (!n) {
          return {
            NFS: codigo,
            encontrada: false,
            cancelada: false,
            STATUS: null,
            DT_EMISSAO: null,
            CLIENTE: null,
            TOTAL_NOTA: null,
            OPF_CODIGO: null,
            OPF_DESCRICAO: null,
          };
        }
        return {
          ...this.notaListada(n),
          encontrada: true,
          cancelada: this.cancelada(n),
        };
      }),
    };
  }

  async notas(filtro: FiltroNotas): Promise<ComFonte<NotaListada[]>> {
    if (!filtro.operacoes.length)
      throw new BadRequestException('Selecione ao menos uma operação');
    if (filtro.operacoes.length > TAMANHO_LOTE)
      throw new BadRequestException(
        `No máximo ${TAMANHO_LOTE} operações por vez`,
      );
    const { fonte, valor } = await this.comFonte('notas', (f) =>
      f.notasPorPeriodo(filtro),
    );
    return { fonte, itens: valor.map((n) => this.notaListada(n)) };
  }

  async conciliar(body: ConciliarBody): Promise<ConciliacaoResultado> {
    const modo = String(body?.modo ?? '') as ModoConciliacao;

    if (modo === 'grupo') {
      const grupos = lerInteiros(body.grupos, 'grupos');
      const subgrupos = lerInteiros(body.subgrupos, 'subgrupos');
      if (!grupos.length && !subgrupos.length) {
        throw new BadRequestException(
          'Selecione ao menos um grupo ou subgrupo',
        );
      }
      // Grupos e subgrupos vão num `em` único (dentro do OU da taxonomia), sem lotes.
      if (grupos.length > TAMANHO_LOTE || subgrupos.length > TAMANHO_LOTE) {
        throw new BadRequestException(
          `No máximo ${TAMANHO_LOTE} grupos e ${TAMANHO_LOTE} subgrupos por vez`,
        );
      }
      const { fonte, valor } = await this.comFonte(
        'conciliar-grupo',
        async (f) => {
          const produtos = await f.produtosGerencial({ grupos, subgrupos });
          const saldos = await f.saldosFiscal(
            produtos.map((p) => numero(p.PRO_CODIGO)),
          );
          return { produtos, saldos };
        },
      );
      const itens = this.montarLinhas(valor.produtos, valor.saldos).filter(
        (l) =>
          l.E1_DISPONIVEL ||
          l.E1_RESERVADO ||
          l.E3_DISPONIVEL ||
          l.E3_RESERVADO,
      );
      return { fonte, modo, itens, avisos: [] };
    }

    if (modo === 'venda' || modo === 'operacao') {
      const nfs = lerInteiros(body.nfs, 'nfs');
      if (!nfs.length)
        throw new BadRequestException('Informe ao menos uma nota');
      const max = modo === 'venda' ? MAX_VENDAS : MAX_NOTAS;
      if (nfs.length > max)
        throw new BadRequestException(`No máximo ${max} notas por vez`);

      const { fonte, valor } = await this.comFonte(
        `conciliar-${modo}`,
        async (f) => {
          const avisos: string[] = [];
          let validas = nfs;

          // Venda é digitada pelo usuário: confere de novo existência e cancelamento.
          if (modo === 'venda') {
            const cabecalhos = await f.notasPorNfs(nfs);
            const porNfs = new Map(cabecalhos.map((n) => [numero(n.NFS), n]));
            const naoEncontradas = nfs.filter((n) => !porNfs.has(n));
            const canceladas = nfs.filter(
              (n) => porNfs.has(n) && this.cancelada(porNfs.get(n)!),
            );
            if (naoEncontradas.length)
              avisos.push(
                `Vendas não encontradas: ${naoEncontradas.join(', ')}`,
              );
            const foraDoStatus = nfs.filter(
              (n) =>
                porNfs.has(n) &&
                !this.cancelada(porNfs.get(n)!) &&
                !STATUS_VENDA.has(numero(porNfs.get(n)!.STATUS)),
            );
            if (canceladas.length)
              avisos.push(
                `Vendas canceladas ignoradas: ${canceladas.join(', ')}`,
              );
            if (foraDoStatus.length)
              avisos.push(
                `Vendas com STATUS fora de 1/2 ignoradas: ${foraDoStatus.join(', ')}`,
              );
            validas = nfs.filter(
              (n) =>
                porNfs.has(n) &&
                !this.cancelada(porNfs.get(n)!) &&
                STATUS_VENDA.has(numero(porNfs.get(n)!.STATUS)),
            );
          }
          if (!validas.length)
            return {
              produtos: [],
              saldos: [],
              movimentos: new Map<number, Movimento>(),
              avisos,
            };

          const itens = await f.itensDasNotas(validas);
          const movimentos = this.agregarItens(itens, modo);
          const codigos = [...movimentos.keys()];
          const produtos = await f.produtosGerencial({ codigos });
          const saldos = await f.saldosFiscal(codigos);

          const semCadastro =
            codigos.length -
            new Set(produtos.map((p) => numero(p.PRO_CODIGO))).size;
          if (semCadastro > 0)
            avisos.push(
              `${semCadastro} produto(s) das notas sem cadastro na empresa 3`,
            );
          return { produtos, saldos, movimentos, avisos };
        },
      );

      const itens = this.montarLinhas(valor.produtos, valor.saldos).map((l) => {
        const m = valor.movimentos.get(l.PRO_CODIGO);
        return {
          ...l,
          QTD_MOVIMENTADA: round(m?.qtd ?? 0),
          NFS: m ? [...m.nfs].sort((a, b) => a - b) : [],
          ...(modo === 'operacao'
            ? { OPERACOES: m ? [...m.operacoes].sort() : [] }
            : {}),
        };
      });
      return { fonte, modo, itens, avisos: valor.avisos };
    }

    throw new BadRequestException('modo deve ser grupo, venda ou operacao');
  }

  /**
   * Kardex das duas empresas lado a lado e onde a diferença nasceu. O kardex é
   * lido desde o início do período menos a janela de casamento (o espelho de um
   * lançamento do começo do período pode estar antes dele) até o último
   * lançamento, sem corte por cima: a curva anda para trás a partir do saldo de
   * hoje, então precisa de tudo o que veio depois do período.
   */
  async rastreio(
    codigo: number,
    periodo: PeriodoRastreio,
  ): Promise<RastreioResultado> {
    const desde = periodo.data_inicial
      ? somarDias(periodo.data_inicial, -JANELA_CASAMENTO_DIAS)
      : undefined;
    const { fonte, valor } = await this.comFonte('rastreio', async (f) => {
      const [produto] = await f.produtosGerencial({ codigos: [codigo] });
      if (!produto) return null;
      return {
        produto,
        saldos: await f.saldosFiscal([codigo]),
        k1: await f.kardex(EMPRESA_FISCAL, codigo, desde),
        k3: await f.kardex(EMPRESA_GERENCIAL, codigo, desde),
        t1: await f.totaisKardex(EMPRESA_FISCAL, codigo),
        t3: await f.totaisKardex(EMPRESA_GERENCIAL, codigo),
      };
    });
    if (!valor)
      throw new NotFoundException(
        `Produto ${codigo} não encontrado na empresa 3`,
      );

    const l = this.montarLinhas([valor.produto], valor.saldos)[0];
    const r = rastrear({
      produto: { PRO_CODIGO: l.PRO_CODIGO, PRO_DESCRICAO: l.PRO_DESCRICAO },
      periodo,
      empresas: {
        [EMPRESA_FISCAL]: {
          disponivel: l.E1_DISPONIVEL,
          reservado: l.E1_RESERVADO,
          ...totais(valor.t1),
          kardex: valor.k1,
        },
        [EMPRESA_GERENCIAL]: {
          disponivel: l.E3_DISPONIVEL,
          reservado: l.E3_RESERVADO,
          ...totais(valor.t3),
          kardex: valor.k3,
        },
      },
    });
    return {
      fonte,
      produto: {
        PRO_CODIGO: l.PRO_CODIGO,
        PRO_DESCRICAO: l.PRO_DESCRICAO,
        REF_FABRICANTE: l.REF_FABRICANTE,
        MARCA: l.MARCA,
        UNIDADE: l.UNIDADE,
        GRP_DESCRICAO: l.GRP_DESCRICAO,
        SUBGRP_DESCRICAO: l.SUBGRP_DESCRICAO,
        LOCALIZACOES: l.LOCALIZACOES,
      },
      ...r,
    };
  }

  /* -------------------------------------------------------------------------- */

  private cancelada(n: NotaRow): boolean {
    return (
      numeroOuNull(n.STATUS) === STATUS_CANCELADA || n.DT_CANCELAMENTO != null
    );
  }

  private notaListada(n: NotaRow): NotaListada {
    return {
      NFS: numero(n.NFS),
      DT_EMISSAO: dataIso(n.DT_EMISSAO),
      STATUS: numeroOuNull(n.STATUS),
      CLIENTE: texto(n.CLIENTE),
      TOTAL_NOTA: numeroOuNull(n.TOTAL_NOTA),
      OPF_CODIGO: texto(n.OPF_CODIGO),
      OPF_DESCRICAO: texto(n.OPF_DESCRICAO),
    };
  }

  /**
   * Venda: QUANTIDADE − QTDE_DEVOLVIDA. Operação: QUANTIDADE como veio, sempre
   * somada positiva (quem escolhe as operações é o usuário).
   */
  private agregarItens(
    itens: ItemNotaRow[],
    modo: 'venda' | 'operacao',
  ): Map<number, Movimento> {
    const mapa = new Map<number, Movimento>();
    for (const it of itens) {
      const codigo = numero(it.PRO_CODIGO);
      if (!codigo) continue;
      let m = mapa.get(codigo);
      if (!m) {
        m = { qtd: 0, nfs: new Set(), operacoes: new Set() };
        mapa.set(codigo, m);
      }
      const qtd = numero(it.QUANTIDADE);
      m.qtd +=
        modo === 'venda' ? qtd - numero(it.QTDE_DEVOLVIDA) : Math.abs(qtd);
      m.nfs.add(numero(it.NFS));
      const opf = texto(it.OPF_CODIGO);
      if (opf) m.operacoes.add(opf);
    }
    return mapa;
  }

  private montarLinhas(
    produtos: ProdutoRow[],
    saldos: SaldoRow[],
  ): ConciliacaoLinha[] {
    const fiscal = new Map(saldos.map((s) => [numero(s.PRO_CODIGO), s]));
    return produtos.map((p) => {
      const codigo = numero(p.PRO_CODIGO);
      const e1 = fiscal.get(codigo);
      const e1Disp = numero(e1?.ESTOQUE_DISPONIVEL);
      const e1Res = numero(e1?.ESTOQUE_RESERVADO);
      const e3Disp = numero(p.ESTOQUE_DISPONIVEL);
      const e3Res = numero(p.ESTOQUE_RESERVADO);
      return {
        PRO_CODIGO: codigo,
        PRO_DESCRICAO: texto(p.PRO_DESCRICAO),
        REF_FABRICANTE: texto(p.REF_FABRICANTE),
        MARCA: texto(p.MAR_DESCRICAO),
        UNIDADE: texto(p.UNIDADE),
        GRP_CODIGO: numeroOuNull(p.GRP_CODIGO),
        GRP_DESCRICAO: texto(p.GRP_DESCRICAO),
        SUBGRP_CODIGO: numeroOuNull(p.SUBGRP_CODIGO),
        SUBGRP_DESCRICAO: texto(p.SUBGRP_DESCRICAO),
        LOCALIZACOES: this.localizacoes(p),
        E1_DISPONIVEL: e1Disp,
        E1_RESERVADO: e1Res,
        E3_DISPONIVEL: e3Disp,
        E3_RESERVADO: e3Res,
        DIFERENCA: round(e3Disp + e3Res - (e1Disp + e1Res)),
        SEM_CADASTRO_FISCAL: !e1,
      };
    });
  }

  /** Mesma regra da contagem: LOCALIZACAO normalizada e a segunda vinda de APLICACOES, sem duplicar a linha. */
  private localizacoes(p: ProdutoRow): string[] {
    const bruta = texto(p.LOCALIZACAO);
    const principal = formatAndValidateLocation(bruta) ?? bruta;
    const segunda = formatAndValidateLocation(texto(p.APLICACOES));
    return [...new Set([principal, segunda].filter((l): l is string => !!l))];
  }
}
