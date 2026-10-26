// Rastreio da divergência de um produto entre a empresa 1 (fiscal) e a 3 (gerencial).
//
// Função pura: recebe o kardex das duas empresas e o saldo do cadastro e devolve
// a curva diária da diferença E3 − E1, o casamento lançamento a lançamento entre
// as empresas e os degraus (dias em que a diferença mudou), com a explicação de
// cada um. Regras em docs/conciliacao-rastreio.md, seção 4.2.

import {
  EMPRESA_FISCAL,
  EMPRESA_GERENCIAL,
  KardexRow,
} from './conciliacao.types';
import {
  dataIso,
  hora,
  numero,
  numeroOuNull,
  round,
  texto,
} from './normalizar';

type Empresa = typeof EMPRESA_FISCAL | typeof EMPRESA_GERENCIAL;
export type Classe =
  'saida' | 'entrada' | 'cancelamento' | 'reserva' | 'ajuste' | 'outro';
export type StatusLancamento =
  | 'normal'
  | 'atrasado'
  | 'sem_espelho'
  | 'cancelado'
  | 'reserva'
  | 'ajuste'
  | 'nao_classificado';
export type TipoDegrau =
  'sem_espelho' | 'ajuste' | 'nao_classificado' | 'nao_explicado';
type DocumentoTipo = 'NFS' | 'NFE' | 'CONDICIONAL' | 'OS' | 'CONTAGEM';

/** Espelho entre empresas costuma atrasar de 1 a 5 dias; 30 dá folga sem casar coisas sem relação. */
export const JANELA_CASAMENTO_DIAS = 30;
const EPS = 0.0005;

/** Dicionário de ORIGEM do Celta: classe para o casamento, rótulo e como o resumo chama o lançamento. */
const ORIGENS: Record<string, [Classe, string, string?]> = {
  NFS: ['saida', 'Nota fiscal de saída', 'venda'],
  EVF: ['saida', 'Entrega de venda futura'],
  VEF: ['saida', 'Venda fora do estabelecimento'],
  DEF: ['saida', 'Devolução a fornecedor'],
  NFE: ['entrada', 'Nota fiscal de compra', 'compra'],
  NEN: ['entrada', 'Nota de entrada de emissão própria'],
  DEV: ['entrada', 'Devolução de cliente'],
  CNS: ['cancelamento', 'Cancelamento de nota de venda'],
  ENS: ['cancelamento', 'Estorno de nota de venda'],
  CNE: ['cancelamento', 'Cancelamento de nota de compra'],
  CON: ['reserva', 'Condicional'],
  OSV: ['reserva', 'Ordem de serviço'],
  PRE: ['reserva', 'Pré-venda'],
  RMF: ['reserva', 'Remessa p/ venda fora'],
  REF: ['reserva', 'Retorno de remessa fora'],
  RMC: ['reserva', 'Remessa p/ conserto'],
  RRC: ['reserva', 'Retorno de conserto'],
  CDE: ['ajuste', 'Contagem de estoque'],
  LIA: ['ajuste', 'Lançamento individual de ajuste'],
  CAD: ['ajuste', 'Lançamento direto pelo cadastro'],
  EFD: ['ajuste', 'Ajuste do SPED Fiscal'],
  CDP: ['ajuste', 'Controle de produção'],
};

const PERSISTENTES = new Set<string>([
  'sem_espelho',
  'ajuste',
  'nao_classificado',
  'nao_explicado',
]);
/**
 * Lançamentos que explicam a mudança da diferença num dia. `cancelado` entra
 * porque nota e cancelamento em dias diferentes, só numa empresa, mexem na
 * diferença por alguns dias (temporário); no mesmo dia o par se anula.
 */
const EXPLICAM_DEGRAU = new Set<StatusLancamento>([
  'sem_espelho',
  'ajuste',
  'atrasado',
  'nao_classificado',
  'cancelado',
]);

export interface Par {
  empresa: Empresa;
  lancto: number;
  atraso_dias: number;
}

export interface Lancamento {
  empresa: Empresa;
  lancto: number;
  data: string;
  hora: string | null;
  origem: string;
  rotulo: string;
  classe: Classe;
  operacao: 'E' | 'S';
  tipo_estoque: number | null;
  quantidade: number;
  delta: number;
  documento: number | null;
  documento_tipo: DocumentoTipo | null;
  usuario: number | null;
  maquina: string | null;
  status: StatusLancamento;
  par: Par | null;
}

export interface EmpresaEntrada {
  disponivel: number;
  reservado: number;
  /** Σ QUANTIDADE do kardex inteiro, para conferir com o cadastro. */
  entradas: number;
  saidas: number;
  /** Kardex do período (com a margem de casamento antes do início) até hoje. */
  kardex: KardexRow[];
}

export interface EntradaRastreio {
  produto: { PRO_CODIGO: number; PRO_DESCRICAO: string | null };
  /** data_inicial null = tudo. */
  periodo: { data_inicial: string | null; data_final: string };
  empresas: Record<Empresa, EmpresaEntrada>;
}

export interface Degrau {
  data: string;
  delta: number;
  tipo: TipoDegrau;
  empresa: Empresa | null;
  lancto: number | null;
  origem: string | null;
  rotulo: string | null;
  documento: number | null;
  quantidade: number | null;
  usuario: number | null;
  maquina: string | null;
  descricao: string;
}

export interface Temporario {
  data_ida: string;
  data_volta: string;
  atraso_dias: number;
  descricao: string;
}

export interface DiaRastreio {
  data: string;
  e1: { lancamentos: Lancamento[]; saldo_fim: number };
  e3: { lancamentos: Lancamento[]; saldo_fim: number };
  diferenca_fim: number;
  degrau: { delta: number; persistente: boolean } | null;
}

export interface EmpresaRastreio {
  disponivel: number;
  reservado: number;
  saldo: number;
  kardex_entradas: number;
  kardex_saidas: number;
  kardex_bate: boolean;
  lancamentos: number;
  saldo_inicio_periodo: number;
}

export interface Rastreio {
  periodo: { data_inicial: string | null; data_final: string; tudo: boolean };
  empresas: Record<Empresa, EmpresaRastreio>;
  diferenca_atual: number;
  diferenca_inicio_periodo: number;
  dias: DiaRastreio[];
  degraus: Degrau[];
  temporarios: Temporario[];
  constante: boolean;
  constante_desde: string | null;
  resumo_texto: string;
  avisos: string[];
}

/* ------------------------------- auxiliares ------------------------------- */

function diaNum(data: string): number {
  return Date.parse(`${data}T00:00:00Z`) / 86_400_000;
}

export function dataBr(data: string): string {
  return `${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}`;
}

function qtd(n: number): string {
  return `${n < 0 ? '−' : ''}${String(Math.abs(round(n))).replace('.', ',')}`;
}

function sinal(n: number): string {
  return n > 0 ? `+${qtd(n)}` : qtd(n);
}

function docTexto(l: Lancamento): string {
  return l.documento != null ? ` ${l.documento_tipo} ${l.documento}` : '';
}

function quem(l: Lancamento): string {
  const partes = [
    l.maquina,
    l.usuario != null ? `usuário ${l.usuario}` : null,
  ].filter(Boolean);
  return partes.length ? ` (${partes.join(', ')})` : '';
}

function acao(l: Lancamento): string {
  return ORIGENS[l.origem]?.[2] ?? l.rotulo.toLowerCase();
}

function normalizar(r: KardexRow, empresa: Empresa): Lancamento {
  const origem = (texto(r.ORIGEM) ?? '').toUpperCase();
  const [classe, rotulo] =
    ORIGENS[origem] ?? (['outro', `${origem}?`] as const);
  const operacao = (texto(r.OPERACAO) ?? '').toUpperCase() === 'E' ? 'E' : 'S';
  const quantidade = round(numero(r.QUANTIDADE));
  const docs: [DocumentoTipo, unknown][] = [
    ['NFS', r.NFS],
    ['NFE', r.NFE],
    ['CONDICIONAL', r.CONDICIONAL],
    ['OS', r.ORDEM_SERVICO],
    ['CONTAGEM', r.CONTAGEM_ESTOQUE],
  ];
  const doc = docs.find(([, v]) => numeroOuNull(v));
  const status: StatusLancamento =
    classe === 'reserva'
      ? 'reserva'
      : classe === 'ajuste'
        ? 'ajuste'
        : classe === 'outro'
          ? 'nao_classificado'
          : 'sem_espelho';
  return {
    empresa,
    lancto: numero(r.LANCTO),
    data: dataIso(r.DATA) ?? '',
    hora: hora(r.HORA_SERVIDOR),
    origem,
    rotulo,
    classe,
    operacao,
    tipo_estoque: numeroOuNull(r.TIPO_ESTOQUE),
    quantidade,
    delta: operacao === 'E' ? quantidade : -quantidade,
    documento: doc ? numeroOuNull(doc[1]) : null,
    documento_tipo: doc ? doc[0] : null,
    usuario: numeroOuNull(r.USU_CODIGO),
    maquina: texto(r.MAQUINA),
    status,
    par: null,
  };
}

/**
 * CNS/ENS cancelam uma saída e CNE uma entrada, sempre na mesma empresa: pelo
 * número do documento; sem número, pela mesma quantidade no mesmo dia. O par
 * cancelado sai do casamento entre empresas. Percorre em ordem de LANCTO, então
 * NF cancelada e relançada com o mesmo número cancela a primeira, e a segunda
 * fica para casar. Cancelamento cujo documento não está no kardex lido fica
 * `sem_espelho`: o efeito dele na diferença é permanente dentro do período.
 */
function marcarCancelamentos(ls: Lancamento[]) {
  for (const c of ls) {
    if (c.classe !== 'cancelamento') continue;
    const alvoClasse: Classe = c.origem === 'CNE' ? 'entrada' : 'saida';
    const livre = (l: Lancamento) =>
      l.classe === alvoClasse &&
      l.status === 'sem_espelho' &&
      l.operacao !== c.operacao &&
      l.quantidade === c.quantidade;
    const alvo =
      c.documento != null
        ? ls.find(
            (l) =>
              livre(l) &&
              l.documento_tipo === c.documento_tipo &&
              l.documento === c.documento,
          )
        : ls.find((l) => livre(l) && l.data === c.data);
    if (alvo) alvo.status = c.status = 'cancelado';
  }
}

function chaveCasamento(l: Lancamento): string {
  return `${l.classe}|${l.operacao}|${l.quantidade}`;
}

function parear(a: Lancamento, b: Lancamento, atraso: number) {
  a.par = { empresa: EMPRESA_FISCAL, lancto: b.lancto, atraso_dias: atraso };
  b.par = { empresa: EMPRESA_GERENCIAL, lancto: a.lancto, atraso_dias: atraso };
  a.status = b.status = atraso === 0 ? 'normal' : 'atrasado';
}

/**
 * Casa os lançamentos físicos sem par da empresa 3 com os da empresa 1 de mesma
 * classe, sentido e quantidade, em ordem crescente de atraso: primeiro todos os
 * pares do mesmo dia, depois os de 1 dia, e assim por diante até a janela; no
 * empate, o mesmo usuário. Fazer por nível de atraso, e não lançamento a
 * lançamento, evita o efeito cascata: a venda sem espelho de um dia "roubaria"
 * o espelho da venda do dia seguinte, que roubaria o do outro, e o sem espelho
 * apareceria semanas depois do dia em que a diferença nasceu. Por ser global,
 * uma passada da empresa 1 para a 3 não acharia nada novo.
 */
function casarNaJanela(l3: Lancamento[], l1: Lancamento[]) {
  const pendentes = l3.filter((l) => l.status === 'sem_espelho');
  const indice = new Map<string, Lancamento[]>();
  for (const b of l1) {
    if (b.status !== 'sem_espelho') continue;
    const k = `${chaveCasamento(b)}|${diaNum(b.data)}`;
    indice.set(k, [...(indice.get(k) ?? []), b]);
  }
  if (!pendentes.length || !indice.size) return;

  for (let atraso = 0; atraso <= JANELA_CASAMENTO_DIAS; atraso++) {
    for (const a of pendentes) {
      if (a.par) continue;
      const d = diaNum(a.data);
      const candidatos = [d - atraso, ...(atraso ? [d + atraso] : [])]
        .flatMap((dia) => indice.get(`${chaveCasamento(a)}|${dia}`) ?? [])
        .filter((b) => !b.par);
      if (candidatos.length)
        parear(
          a,
          candidatos.find((c) => c.usuario === a.usuario) ?? candidatos[0],
          atraso,
        );
    }
  }
}

/**
 * Segunda passada, sem limite de dias, só entre o que sobrou: espelho que
 * demorou mais que a janela (já houve devolução espelhada 61 dias depois) não
 * pode virar dois "sem espelho". Aqui mesmo usuário e mesma máquina deixam de
 * ser desempate e passam a ser exigência: o espelho tardio é a mesma pessoa
 * lançando do mesmo posto. Sem isso, duas vendas sem espelho de anos
 * diferentes, uma em cada empresa, casariam entre si e as duas origens da
 * diferença sumiriam (só o usuário não basta: o mesmo vendedor vende no CAIXA
 * de uma empresa e no desktop da outra).
 */
function casarFora(l3: Lancamento[], l1: Lancamento[]) {
  const autor = (l: Lancamento) =>
    l.usuario != null && l.maquina
      ? `${l.usuario}|${l.maquina.toUpperCase()}`
      : null;
  const livres1 = l1.filter((l) => l.status === 'sem_espelho' && autor(l));
  const pares: [number, Lancamento, Lancamento][] = [];
  for (const a of l3) {
    if (a.status !== 'sem_espelho' || !autor(a)) continue;
    for (const b of livres1) {
      if (autor(b) === autor(a) && chaveCasamento(b) === chaveCasamento(a)) {
        pares.push([Math.abs(diaNum(b.data) - diaNum(a.data)), a, b]);
      }
    }
  }
  pares.sort((x, y) => x[0] - y[0]);
  for (const [atraso, a, b] of pares)
    if (!a.par && !b.par) parear(a, b, atraso);
}

function descreverDegrau(
  tipo: TipoDegrau,
  l: Lancamento | null,
  valor: number,
): string {
  if (!l) return `diferença sem lançamento que a explique · ${sinal(valor)}`;
  if (tipo === 'ajuste') {
    return `ajuste só na empresa ${l.empresa}: ${l.rotulo.toLowerCase()}${docTexto(l)}${quem(l)} · ${sinal(valor)}`;
  }
  if (tipo === 'nao_classificado') {
    return `origem ${l.rotulo} não classificada${docTexto(l)}${quem(l)} na empresa ${l.empresa} · ${sinal(valor)}`;
  }
  return `${acao(l)}${docTexto(l)}${quem(l)} só na empresa ${l.empresa} · ${sinal(valor)}`;
}

/* --------------------------------- cálculo -------------------------------- */

export function rastrear(entrada: EntradaRastreio): Rastreio {
  const { periodo } = entrada;
  const tudo = periodo.data_inicial == null;
  const noPeriodo = (data: string) =>
    tudo || (data >= periodo.data_inicial! && data <= periodo.data_final);

  const ls = {
    [EMPRESA_FISCAL]: entrada.empresas[EMPRESA_FISCAL].kardex.map((r) =>
      normalizar(r, EMPRESA_FISCAL),
    ),
    [EMPRESA_GERENCIAL]: entrada.empresas[EMPRESA_GERENCIAL].kardex.map((r) =>
      normalizar(r, EMPRESA_GERENCIAL),
    ),
  } as Record<Empresa, Lancamento[]>;
  for (const lista of Object.values(ls)) {
    lista.sort((a, b) =>
      a.data < b.data ? -1 : a.data > b.data ? 1 : a.lancto - b.lancto,
    );
    marcarCancelamentos(lista);
  }
  casarNaJanela(ls[EMPRESA_GERENCIAL], ls[EMPRESA_FISCAL]);
  casarFora(ls[EMPRESA_GERENCIAL], ls[EMPRESA_FISCAL]);

  // Curva para trás a partir do cadastro (disp + res): saldo no fim de cada dia com movimento.
  const empresas = {} as Record<Empresa, EmpresaRastreio>;
  const saldoFim = {} as Record<Empresa, Map<string, number>>;
  const avisos: string[] = [];
  for (const e of [EMPRESA_FISCAL, EMPRESA_GERENCIAL] as Empresa[]) {
    const cad = entrada.empresas[e];
    const saldo = round(cad.disponivel + cad.reservado);
    const fim = new Map<string, number>();
    let s = saldo;
    let inicio = saldo;
    for (let i = ls[e].length - 1; i >= 0; i--) {
      const l = ls[e][i];
      if (!fim.has(l.data)) fim.set(l.data, round(s));
      s -= l.delta;
      if (tudo || l.data >= periodo.data_inicial!) inicio = s;
    }
    saldoFim[e] = fim;

    const kardex = round(cad.entradas - cad.saidas);
    const bate = Math.abs(kardex - saldo) < EPS;
    if (!bate) {
      avisos.push(
        `Cadastro ≠ kardex na empresa ${e}: cadastro (disp + res) ${qtd(saldo)}, kardex (E − S) ${qtd(kardex)}`,
      );
    }
    empresas[e] = {
      disponivel: round(cad.disponivel),
      reservado: round(cad.reservado),
      saldo,
      kardex_entradas: round(cad.entradas),
      kardex_saidas: round(cad.saidas),
      kardex_bate: bate,
      lancamentos: ls[e].filter((l) => noPeriodo(l.data)).length,
      saldo_inicio_periodo: round(inicio),
    };
  }

  // Tabela por dia, com a decomposição de cada degrau.
  const porDia = (e: Empresa) => {
    const m = new Map<string, Lancamento[]>();
    for (const l of ls[e])
      if (noPeriodo(l.data)) m.set(l.data, [...(m.get(l.data) ?? []), l]);
    return m;
  };
  const dia1 = porDia(EMPRESA_FISCAL);
  const dia3 = porDia(EMPRESA_GERENCIAL);
  const datas = [...new Set([...dia1.keys(), ...dia3.keys()])].sort();

  const diferencaInicio = round(
    empresas[EMPRESA_GERENCIAL].saldo_inicio_periodo -
      empresas[EMPRESA_FISCAL].saldo_inicio_periodo,
  );
  let s1 = empresas[EMPRESA_FISCAL].saldo_inicio_periodo;
  let s3 = empresas[EMPRESA_GERENCIAL].saldo_inicio_periodo;
  let anterior = diferencaInicio;
  const dias: DiaRastreio[] = [];
  const degraus: Degrau[] = [];

  for (const data of datas) {
    s1 = saldoFim[EMPRESA_FISCAL].get(data) ?? s1;
    s3 = saldoFim[EMPRESA_GERENCIAL].get(data) ?? s3;
    const lancs = [...(dia1.get(data) ?? []), ...(dia3.get(data) ?? [])];
    const diferenca = round(s3 - s1);
    const delta = round(diferenca - anterior);
    anterior = diferenca;

    // Componentes do dia: valor de cada lançamento na diferença E3 − E1.
    const componentes = lancs
      .filter((l) => EXPLICAM_DEGRAU.has(l.status))
      .map((l) => ({
        l,
        valor: l.empresa === EMPRESA_GERENCIAL ? l.delta : -l.delta,
      }));
    const persistentes = componentes.filter((c) =>
      PERSISTENTES.has(c.l.status),
    );
    const somaPersistente = round(
      persistentes.reduce((t, c) => t + c.valor, 0),
    );
    const residual = round(
      delta - componentes.reduce((t, c) => t + c.valor, 0),
    );

    // Também é degrau o dia em que a diferença não mudou mas um efeito
    // persistente foi encoberto pela volta de um espelho atrasado: sem ele, a
    // soma dos degraus listados não fecharia com a diferença.
    let degrau: DiaRastreio['degrau'] = null;
    if (Math.abs(delta) >= EPS || Math.abs(somaPersistente) >= EPS) {
      for (const { l, valor } of persistentes) {
        const tipo = l.status as TipoDegrau;
        degraus.push({
          data,
          delta: valor,
          tipo,
          empresa: l.empresa,
          lancto: l.lancto,
          origem: l.origem,
          rotulo: l.rotulo,
          documento: l.documento,
          quantidade: l.quantidade,
          usuario: l.usuario,
          maquina: l.maquina,
          descricao: descreverDegrau(tipo, l, valor),
        });
      }
      if (Math.abs(residual) >= EPS) {
        degraus.push({
          data,
          delta: residual,
          tipo: 'nao_explicado',
          empresa: null,
          lancto: null,
          origem: null,
          rotulo: null,
          documento: null,
          quantidade: null,
          usuario: null,
          maquina: null,
          descricao: descreverDegrau('nao_explicado', null, residual),
        });
      }
      degrau = {
        delta,
        persistente: persistentes.length > 0 || Math.abs(residual) >= EPS,
      };
    }

    dias.push({
      data,
      e1: { lancamentos: dia1.get(data) ?? [], saldo_fim: round(s1) },
      e3: { lancamentos: dia3.get(data) ?? [], saldo_fim: round(s3) },
      diferenca_fim: diferenca,
      degrau,
    });
  }

  // Espelhos atrasados com alguma ponta no período: um por par.
  const porLancto1 = new Map(ls[EMPRESA_FISCAL].map((l) => [l.lancto, l]));
  const temporarios: Temporario[] = [];
  for (const a of ls[EMPRESA_GERENCIAL]) {
    if (a.status !== 'atrasado') continue;
    const b = porLancto1.get(a.par!.lancto)!;
    if (!noPeriodo(a.data) && !noPeriodo(b.data)) continue;
    const [ida, volta] = a.data <= b.data ? [a, b] : [b, a];
    temporarios.push({
      data_ida: ida.data,
      data_volta: volta.data,
      atraso_dias: a.par!.atraso_dias,
      descricao:
        `${acao(ida)}${docTexto(ida)} na empresa ${ida.empresa} em ${dataBr(ida.data)}, ` +
        `espelho${docTexto(volta)} na empresa ${volta.empresa} em ${dataBr(volta.data)} (${a.par!.atraso_dias} dias)`,
    });
  }
  temporarios.sort((x, y) =>
    x.data_ida < y.data_ida ? -1 : x.data_ida > y.data_ida ? 1 : 0,
  );

  const e1 = empresas[EMPRESA_FISCAL];
  const e3 = empresas[EMPRESA_GERENCIAL];
  const diferencaAtual = round(e3.saldo - e1.saldo);
  // Diferença no fim do período (igual à atual quando o período termina hoje).
  const diferencaFim = dias.length
    ? dias[dias.length - 1].diferenca_fim
    : diferencaInicio;
  // No modo tudo o início é o primeiro dia plausível: a empresa 3 tem lançamentos com data 1899.
  const inicio = tudo
    ? (datas.find((d) => d >= '2000-01-01') ?? datas[0] ?? null)
    : periodo.data_inicial;
  const constante = !degraus.length && Math.abs(diferencaFim) >= EPS;

  const linhas = [
    `${entrada.produto.PRO_CODIGO} ${entrada.produto.PRO_DESCRICAO ?? ''}`.trim(),
    `Empresa 1: ${qtd(e1.saldo)} (disp ${qtd(e1.disponivel)} + res ${qtd(e1.reservado)}) · ` +
      `Empresa 3: ${qtd(e3.saldo)} (disp ${qtd(e3.disponivel)} + res ${qtd(e3.reservado)}) · ` +
      `Diferença E3−E1: ${qtd(diferencaAtual)}`,
    '',
  ];
  if (constante && inicio) {
    linhas.push(
      `Constante desde ${dataBr(inicio)} (início do período): nasceu antes, conferir entrada ou cadastro; amplie o período.`,
    );
  } else if (!degraus.length) {
    linhas.push('Nenhum degrau persistente no período.');
  }
  for (const d of degraus) linhas.push(`${dataBr(d.data)} · ${d.descricao}`);
  if (temporarios.length)
    linhas.push(
      '',
      `${temporarios.length} espelho(s) atrasado(s) que se corrigiram no período.`,
    );
  if (avisos.length) linhas.push('', ...avisos);

  return {
    periodo: { data_inicial: inicio, data_final: periodo.data_final, tudo },
    empresas: { [EMPRESA_FISCAL]: e1, [EMPRESA_GERENCIAL]: e3 } as Record<
      Empresa,
      EmpresaRastreio
    >,
    diferenca_atual: diferencaAtual,
    diferenca_inicio_periodo: diferencaInicio,
    dias,
    degraus,
    temporarios,
    constante,
    constante_desde: constante ? inicio : null,
    resumo_texto: linhas.join('\n'),
    avisos,
  };
}
