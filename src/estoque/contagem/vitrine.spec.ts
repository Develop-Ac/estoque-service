import { dataOntem, filtrarVitrine, locacaoEhVitrine } from './vitrine';
import { EstoqueSaidaRow } from './contagem.types';

const linha = (LOCALIZACAO: string | null, COD_PRODUTO = 1): EstoqueSaidaRow => ({
  data: '2026-09-22',
  COD_PRODUTO,
  DESC_PRODUTO: 'PRODUTO',
  mar_descricao: 'MARCA',
  ref_fabricante: null,
  ref_FORNECEDOR: null,
  LOCALIZACAO,
  unidade: 'UN',
  APLICACOES: null,
  codigo_barras: null,
  QTDE_SAIDA: 1,
  ESTOQUE: 10,
  RESERVA: 0,
});

describe('locacaoEhVitrine', () => {
  it('reconhece a vitrine fixa, posições V<dígito> e a Vitrine Móvel (VM)', () => {
    expect(locacaoEhVitrine('VITRINE')).toBe(true);
    expect(locacaoEhVitrine(' vitrine ')).toBe(true);
    expect(locacaoEhVitrine('V101A01')).toBe(true);
    expect(locacaoEhVitrine('VM202A01')).toBe(true);
    expect(locacaoEhVitrine('vm0202a01')).toBe(true);
  });

  it('rejeita corredores, BOX, VENDA CASADA e vazio', () => {
    expect(locacaoEhVitrine('A1204E02')).toBe(false);
    expect(locacaoEhVitrine('BOX 03')).toBe(false);
    expect(locacaoEhVitrine('VENDA CASADA')).toBe(false);
    expect(locacaoEhVitrine('')).toBe(false);
    expect(locacaoEhVitrine(null)).toBe(false);
    expect(locacaoEhVitrine(undefined)).toBe(false);
  });
});

describe('filtrarVitrine', () => {
  it('mantém só as linhas da vitrine (uma linha por locação, como vem do fetchSaidas)', () => {
    const rows = [
      linha('A1204E02', 1),
      linha('VM202A01', 1),
      linha('VITRINE', 2),
      linha('B1002A03', 3),
      linha(null, 4),
    ];
    const out = filtrarVitrine(rows);
    expect(out.map((r) => `${r.COD_PRODUTO}|${r.LOCALIZACAO}`)).toEqual(['1|VM202A01', '2|VITRINE']);
  });

  it('lista vazia/undefined devolve []', () => {
    expect(filtrarVitrine([])).toEqual([]);
    expect(filtrarVitrine(undefined as any)).toEqual([]);
  });
});

describe('dataOntem', () => {
  it('usa a data civil de Brasília: 01:00 UTC ainda é o dia anterior em SP', () => {
    // 2026-09-23T01:00Z = 2026-09-22 22:00 em São Paulo -> ontem = 2026-09-21
    expect(dataOntem(new Date('2026-09-23T01:00:00Z'))).toBe('2026-09-21');
  });

  it('ao meio-dia UTC o dia civil coincide e ontem é o dia anterior', () => {
    expect(dataOntem(new Date('2026-09-23T12:00:00Z'))).toBe('2026-09-22');
  });

  it('atravessa virada de mês e de ano', () => {
    expect(dataOntem(new Date('2026-10-01T12:00:00Z'))).toBe('2026-09-30');
    expect(dataOntem(new Date('2027-01-01T12:00:00Z'))).toBe('2026-12-31');
  });
});
