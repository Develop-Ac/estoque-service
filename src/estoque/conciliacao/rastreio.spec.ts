import { readFileSync } from 'fs';
import { join } from 'path';
import { KardexRow } from './conciliacao.types';
import { EntradaRastreio, rastrear } from './rastreio';

let seq = 1;
function k(
  data: string,
  origem: string,
  operacao: 'E' | 'S',
  quantidade: number,
  extra: Partial<KardexRow> = {},
): KardexRow {
  return {
    LANCTO: seq++,
    DATA: data,
    HORA_SERVIDOR: '10:00:00',
    ORIGEM: origem,
    OPERACAO: operacao,
    TIPO_ESTOQUE: 0,
    QUANTIDADE: quantidade,
    NFS: null,
    NFS_ITEM: null,
    NFE: null,
    NFE_ITEM: null,
    CONDICIONAL: null,
    ORDEM_SERVICO: null,
    CONTAGEM_ESTOQUE: null,
    USU_CODIGO: 6,
    MAQUINA: 'CAIXA',
    ...extra,
  };
}

/** Saldo do cadastro = Σ(E − S) do kardex informado, salvo `saldos` explícito. */
function entrada(
  e1: KardexRow[],
  e3: KardexRow[],
  data_inicial: string | null = null,
  saldos: { 1?: number; 3?: number } = {},
): EntradaRastreio {
  const emp = (ks: KardexRow[], saldo?: number) => {
    const soma = (op: string) =>
      ks
        .filter((l) => l.OPERACAO === op)
        .reduce((t, l) => t + Number(l.QUANTIDADE), 0);
    const entradas = soma('E');
    const saidas = soma('S');
    return {
      disponivel: saldo ?? entradas - saidas,
      reservado: 0,
      entradas,
      saidas,
      kardex: ks,
    };
  };
  return {
    produto: { PRO_CODIGO: 1, PRO_DESCRICAO: 'PRODUTO' },
    periodo: { data_inicial, data_final: '2026-10-26' },
    empresas: { 1: emp(e1, saldos[1]), 3: emp(e3, saldos[3]) },
  };
}

const compra = (data: string, nfe: number) =>
  k(data, 'NFE', 'E', 5, { NFE: nfe });
const venda = (data: string, nfs: number, extra: Partial<KardexRow> = {}) =>
  k(data, 'NFS', 'S', 1, { NFS: nfs, ...extra });

describe('rastrear', () => {
  it('curva para trás a partir de disp + res; dia sem movimento mantém o saldo; reserva não gera degrau', () => {
    const r = rastrear(
      entrada(
        [compra('2026-01-10', 1), venda('2026-01-20', 2)],
        [
          compra('2026-01-10', 11),
          k('2026-01-15', 'CON', 'S', 1, { CONDICIONAL: 7 }),
          k('2026-01-15', 'CON', 'E', 1, { CONDICIONAL: 7, TIPO_ESTOQUE: 1 }),
          venda('2026-01-20', 12),
        ],
        '2026-01-12',
      ),
    );
    expect(r.empresas[1]).toMatchObject({
      saldo: 4,
      saldo_inicio_periodo: 5,
      lancamentos: 1,
      kardex_bate: true,
    });
    expect(r.empresas[3]).toMatchObject({
      saldo: 4,
      saldo_inicio_periodo: 5,
      lancamentos: 3,
    });
    expect(
      r.dias.map((d) => [
        d.data,
        d.e1.saldo_fim,
        d.e3.saldo_fim,
        d.diferenca_fim,
      ]),
    ).toEqual([
      ['2026-01-15', 5, 5, 0],
      ['2026-01-20', 4, 4, 0],
    ]);
    expect(r.dias[0].e3.lancamentos.map((l) => l.status)).toEqual([
      'reserva',
      'reserva',
    ]);
    expect(r.dias[1].e3.lancamentos[0]).toMatchObject({
      status: 'normal',
      par: { empresa: 1, atraso_dias: 0 },
    });
    expect(r.degraus).toEqual([]);
    expect(r.avisos).toEqual([]);
  });

  it('espelho 4 dias depois: atrasado dos dois lados, degrau temporário', () => {
    const r = rastrear(
      entrada(
        [compra('2026-01-10', 1), venda('2026-01-14', 2)],
        [compra('2026-01-10', 11), venda('2026-01-10', 12)],
      ),
    );
    const lancs = r.dias
      .flatMap((d) => [...d.e1.lancamentos, ...d.e3.lancamentos])
      .filter((l) => l.origem === 'NFS');
    expect(lancs.map((l) => [l.status, l.par?.atraso_dias])).toEqual([
      ['atrasado', 4],
      ['atrasado', 4],
    ]);
    expect(r.dias.map((d) => d.degrau)).toEqual([
      { delta: -1, persistente: false },
      { delta: 1, persistente: false },
    ]);
    expect(r.degraus).toEqual([]);
    expect(r.temporarios).toEqual([
      expect.objectContaining({
        data_ida: '2026-01-10',
        data_volta: '2026-01-14',
        atraso_dias: 4,
      }),
    ]);
  });

  it.each([
    ['venda só na 3', [], [venda('2026-02-01', 9)], 3, -1],
    ['entrada só na 1', [compra('2026-02-01', 9)], [], 1, -5],
    ['venda só na 1', [venda('2026-02-01', 9)], [], 1, 1],
  ])(
    '%s: sem espelho, degrau persistente com o sinal certo',
    (_, e1, e3, empresa, delta) => {
      const r = rastrear(entrada(e1 as KardexRow[], e3 as KardexRow[]));
      expect(r.degraus).toEqual([
        expect.objectContaining({
          data: '2026-02-01',
          tipo: 'sem_espelho',
          empresa,
          delta,
        }),
      ]);
      expect(r.dias[0].degrau).toEqual({ delta, persistente: true });
      expect(r.diferenca_atual).toBe(delta);
    },
  );

  it('venda só na 3 descreve documento, máquina e usuário no resumo', () => {
    const r = rastrear(entrada([], [venda('2025-03-21', 520207)]));
    expect(r.degraus[0].descricao).toBe(
      'venda NFS 520207 (CAIXA, usuário 6) só na empresa 3 · −1',
    );
    expect(r.resumo_texto).toContain(
      '21/03/2025 · venda NFS 520207 (CAIXA, usuário 6) só na empresa 3 · −1',
    );
  });

  it('NFS + CNS com o mesmo número saem do casamento', () => {
    const r = rastrear(
      entrada(
        [],
        [
          venda('2026-03-01', 100),
          k('2026-03-02', 'CNS', 'E', 1, { NFS: 100 }),
        ],
      ),
    );
    expect(
      r.dias.flatMap((d) => d.e3.lancamentos.map((l) => l.status)),
    ).toEqual(['cancelado', 'cancelado']);
    // Nota num dia e cancelamento no outro, só na 3: dois degraus temporários.
    expect(r.dias.map((d) => d.degrau)).toEqual([
      { delta: -1, persistente: false },
      { delta: 1, persistente: false },
    ]);
    expect(r.degraus).toEqual([]);
  });

  it('NFE cancelada e relançada no mesmo dia casa só uma vez', () => {
    const r = rastrear(
      entrada(
        [k('2026-03-01', 'NFE', 'E', 2, { NFE: 20 })],
        [
          k('2026-03-01', 'NFE', 'E', 2, { NFE: 10 }),
          k('2026-03-01', 'CNE', 'S', 2, { NFE: 10 }),
          k('2026-03-01', 'NFE', 'E', 2, { NFE: 11 }),
        ],
      ),
    );
    expect(
      r.dias[0].e3.lancamentos.map((l) => [l.documento, l.status]),
    ).toEqual([
      [10, 'cancelado'],
      [10, 'cancelado'],
      [11, 'normal'],
    ]);
    expect(r.dias[0].e1.lancamentos[0].status).toBe('normal');
    expect(r.degraus).toEqual([]);
  });

  it('CDE só na empresa 1 vira degrau de ajuste explicado', () => {
    const r = rastrear(
      entrada(
        [
          k('2026-06-30', 'CDE', 'S', 1, {
            CONTAGEM_ESTOQUE: 55,
            MAQUINA: 'ACRH01',
            USU_CODIGO: 159,
          }),
        ],
        [],
      ),
    );
    expect(r.degraus).toEqual([
      expect.objectContaining({
        tipo: 'ajuste',
        empresa: 1,
        delta: 1,
        documento: 55,
      }),
    ]);
    expect(r.degraus[0].descricao).toBe(
      'ajuste só na empresa 1: contagem de estoque CONTAGEM 55 (ACRH01, usuário 159) · +1',
    );
  });

  it('origem fora do dicionário entra na curva como não classificada', () => {
    const r = rastrear(entrada([], [k('2026-04-01', 'XYZ', 'E', 1)]));
    expect(r.degraus).toEqual([
      expect.objectContaining({
        tipo: 'nao_classificado',
        rotulo: 'XYZ?',
        delta: 1,
      }),
    ]);
  });

  it('espelho tardio além da janela casa só com mesmo usuário e máquina', () => {
    const dev = (data: string, maquina: string) =>
      k(data, 'DEV', 'E', 1, { NFS: 1, USU_CODIGO: 124, MAQUINA: maquina });
    const ok = rastrear(
      entrada([dev('2026-10-06', 'AC-SAC')], [dev('2026-08-06', 'AC-SAC')]),
    );
    expect(ok.degraus).toEqual([]);
    expect(ok.temporarios).toEqual([
      expect.objectContaining({ atraso_dias: 61 }),
    ]);

    const outro = rastrear(
      entrada([dev('2026-10-06', 'OUTRO-PC')], [dev('2026-08-06', 'AC-SAC')]),
    );
    expect(outro.degraus.map((d) => [d.empresa, d.tipo])).toEqual([
      [3, 'sem_espelho'],
      [1, 'sem_espelho'],
    ]);
  });

  it('diferença 2 sem degrau no período é constante desde o início', () => {
    // A diferença nasceu antes do período: compra de 5 na 1 e de 7 na 3.
    const r = rastrear(
      entrada(
        [compra('2025-01-01', 1), venda('2026-05-01', 2)],
        [k('2025-01-01', 'NFE', 'E', 7, { NFE: 11 }), venda('2026-05-01', 12)],
        '2026-01-01',
      ),
    );
    expect(r.degraus).toEqual([]);
    expect(r).toMatchObject({
      diferenca_atual: 2,
      diferenca_inicio_periodo: 2,
      constante: true,
      constante_desde: '2026-01-01',
    });
    expect(r.resumo_texto).toContain(
      'Constante desde 01/01/2026 (início do período)',
    );
  });

  it('avisa quando o kardex não bate com o cadastro', () => {
    const r = rastrear(
      entrada([compra('2026-01-10', 1)], [compra('2026-01-10', 2)], null, {
        1: 4,
      }),
    );
    expect(r.empresas[1].kardex_bate).toBe(false);
    expect(r.empresas[3].kardex_bate).toBe(true);
    expect(r.avisos).toEqual([
      'Cadastro ≠ kardex na empresa 1: cadastro (disp + res) 4, kardex (E − S) 5',
    ]);
  });
});

/* ------------------------- casos reais do ERP ------------------------------ */

interface Fixture {
  produto: { PRO_CODIGO: number; PRO_DESCRICAO: string | null };
  saldos: Record<'1' | '3', { disponivel: number; reservado: number }>;
  lancamentos: (KardexRow & { EMPRESA: number })[];
}

/** Monta a entrada como o service: kardex desde o início do período − 30 dias; totais do kardex inteiro. */
function real(codigo: number, data_inicial: string | null) {
  const f: Fixture = JSON.parse(
    readFileSync(
      join(__dirname, '../../../docs/fixtures', `rastreio-${codigo}.json`),
      'utf8',
    ),
  );
  const desde = data_inicial
    ? new Date(Date.parse(`${data_inicial}T00:00:00Z`) - 30 * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : '';
  const emp = (e: 1 | 3) => {
    const todos = f.lancamentos.filter((l) => l.EMPRESA === e);
    const soma = (op: string) =>
      todos
        .filter((l) => l.OPERACAO === op)
        .reduce((t, l) => t + Number(l.QUANTIDADE), 0);
    return {
      ...f.saldos[e],
      entradas: soma('E'),
      saidas: soma('S'),
      kardex: todos.filter((l) => String(l.DATA) >= desde),
    };
  };
  return rastrear({
    produto: f.produto,
    periodo: { data_inicial, data_final: '2026-10-26' },
    empresas: { 1: emp(1), 3: emp(3) },
  });
}

const resumo = (r: ReturnType<typeof rastrear>) =>
  r.degraus.map((d) => [
    d.data,
    d.tipo,
    d.empresa,
    d.origem,
    d.documento,
    d.delta,
  ]);

describe('rastrear: casos reais', () => {
  it('32441 tudo: as quatro vendas da empresa 3 sem espelho e diferença −3', () => {
    const r = real(32441, null);
    expect(r.diferenca_atual).toBe(-3);
    expect(r.empresas[1].kardex_bate && r.empresas[3].kardex_bate).toBe(true);
    // Além das quatro NFS da homologação, o kardex tem dois pares que se anulam:
    // venda 398197 e devolução 417872 sem espelho (2022, ambos na 3) e uma venda
    // só na 1 em 26/06/2025 (cancelada e reemitida, a reemissão ficou sem par).
    expect(resumo(r)).toEqual([
      ['2022-05-09', 'sem_espelho', 3, 'NFS', 398197, -1],
      ['2022-11-07', 'sem_espelho', 3, 'DEV', 417872, 1],
      ['2023-04-14', 'sem_espelho', 3, 'NFS', 436814, -1],
      ['2024-01-30', 'sem_espelho', 3, 'NFS', 470849, -1],
      ['2025-01-23', 'sem_espelho', 3, 'NFS', 513615, -1],
      ['2025-03-21', 'sem_espelho', 3, 'NFS', 520207, -1],
      ['2025-06-26', 'sem_espelho', 1, 'NFS', 441438, 1],
    ]);
    expect(r.degraus.reduce((t, d) => t + d.delta, 0)).toBe(
      r.diferenca_atual - r.diferenca_inicio_periodo,
    );
    expect(
      r.temporarios.every((t) => t.atraso_dias >= 1 && t.atraso_dias <= 9),
    ).toBe(true);
    expect(r.resumo_texto.split('\n').slice(0, 2)).toEqual([
      '32441 GRADE HILUX 09/ CINZA C/ FRISO CROMADO',
      'Empresa 1: 5 (disp 5 + res 0) · Empresa 3: 2 (disp 2 + res 0) · Diferença E3−E1: −3',
    ]);
  });

  it('32441 em 12 meses: constante desde o início do período', () => {
    const r = real(32441, '2025-10-26');
    expect(r).toMatchObject({
      constante: true,
      constante_desde: '2025-10-26',
      diferenca_inicio_periodo: -3,
      degraus: [],
    });
  });

  it('46665 em 12 meses: um CDE na empresa 3; NFS cancelada e reemitida não gera degrau', () => {
    const r = real(46665, '2025-10-26');
    expect(r.diferenca_atual).toBe(1);
    expect(r.degraus).toEqual([
      expect.objectContaining({
        data: '2026-10-14',
        tipo: 'ajuste',
        empresa: 3,
        origem: 'CDE',
        lancto: 13584740,
        delta: 1,
      }),
    ]);
    const dia = r.dias.find((d) => d.data === '2026-10-17')!;
    expect(dia.degrau).toBeNull();
    expect(
      dia.e3.lancamentos
        .filter((l) => l.documento === 581757)
        .map((l) => l.status),
    ).toEqual(['cancelado', 'cancelado']);
    expect(dia.e3.lancamentos.find((l) => l.documento === 581760)!.status).toBe(
      'normal',
    );
  });

  it('50311: CDE na empresa 1 e devolução espelhada 61 dias depois como temporária', () => {
    const r = real(50311, '2025-10-26');
    expect(r.diferenca_atual).toBe(-1);
    expect(r.degraus).toEqual([
      expect.objectContaining({
        data: '2026-06-30',
        tipo: 'ajuste',
        empresa: 1,
        origem: 'CDE',
        lancto: 1324734,
        delta: -1,
      }),
    ]);
    expect(r.temporarios).toEqual([
      expect.objectContaining({
        data_ida: '2026-08-06',
        data_volta: '2026-10-06',
        atraso_dias: 61,
      }),
    ]);
  });

  it('26914: constante em 12 meses; no histórico a EVF 438002 sem espelho e a NFE relançada sem degrau', () => {
    expect(real(26914, '2025-10-26')).toMatchObject({
      constante: true,
      constante_desde: '2025-10-26',
      degraus: [],
    });

    const r = real(26914, null);
    expect(r.diferenca_atual).toBe(-1);
    // Em 2021 a empresa 1 teve uma venda e uma compra sem espelho que se anulam;
    // a compra caiu no dia em que voltou um espelho atrasado, então a diferença
    // não mudou naquele dia e o degrau só aparece pela soma dos persistentes.
    expect(resumo(r)).toEqual([
      ['2021-01-21', 'sem_espelho', 1, 'NFS', 283416, 1],
      ['2021-05-17', 'sem_espelho', 1, 'NFE', 18831, -1],
      ['2023-04-25', 'sem_espelho', 3, 'EVF', 438002, -1],
    ]);
    const dia = r.dias.find((d) => d.data === '2023-04-22')!;
    expect(dia.degrau).toBeNull();
    expect(
      dia.e1.lancamentos
        .filter((l) => l.documento === 25480)
        .map((l) => l.status),
    ).toEqual(['cancelado', 'cancelado']);
  });
});
