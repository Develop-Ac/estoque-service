import { BadRequestException } from '@nestjs/common';
import { ConciliacaoService, lerPeriodo } from './conciliacao.service';
import { ConciliacaoFonte, ProdutoRow } from './conciliacao.types';
import { LimiteExcedidoError } from './fontes/lotes';

function produto(codigo: number, extra: Partial<ProdutoRow> = {}): ProdutoRow {
  return {
    PRO_CODIGO: codigo,
    PRO_DESCRICAO: `PRODUTO ${codigo}`,
    REF_FABRICANTE: null,
    UNIDADE: 'UN',
    LOCALIZACAO: null,
    APLICACOES: null,
    ESTOQUE_DISPONIVEL: 0,
    ESTOQUE_RESERVADO: 0,
    SUBGRP_CODIGO: 1,
    SUBGRP_DESCRICAO: 'SUB',
    GRP_CODIGO: 1,
    GRP_DESCRICAO: 'GRP',
    MAR_DESCRICAO: null,
    ...extra,
  };
}

function fonte(nome: 'api' | 'openquery', sobrescrever: Partial<ConciliacaoFonte> = {}): ConciliacaoFonte {
  return {
    nome,
    grupos: jest.fn().mockResolvedValue([]),
    subgrupos: jest.fn().mockResolvedValue([]),
    operacoes: jest.fn().mockResolvedValue([]),
    notasPorNfs: jest.fn().mockResolvedValue([]),
    notasPorPeriodo: jest.fn().mockResolvedValue([]),
    itensDasNotas: jest.fn().mockResolvedValue([]),
    produtosGerencial: jest.fn().mockResolvedValue([]),
    saldosFiscal: jest.fn().mockResolvedValue([]),
    ...sobrescrever,
  } as ConciliacaoFonte;
}

function criar(api: ConciliacaoFonte, oq: ConciliacaoFonte, habilitado = true) {
  return new ConciliacaoService({ habilitado } as any, api as any, oq as any);
}

describe('ConciliacaoService', () => {
  describe('fonte', () => {
    it('usa a api quando habilitada', async () => {
      const api = fonte('api', { grupos: jest.fn().mockResolvedValue([{ GRP_CODIGO: 1, GRP_DESCRICAO: 'A' }]) });
      const oq = fonte('openquery');
      const r = await criar(api, oq).grupos();
      expect(r.fonte).toBe('api');
      expect(oq.grupos).not.toHaveBeenCalled();
    });

    it('cai para OPENQUERY quando a api falha', async () => {
      const api = fonte('api', { grupos: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
      const oq = fonte('openquery', { grupos: jest.fn().mockResolvedValue([{ GRP_CODIGO: 2, GRP_DESCRICAO: 'B' }]) });
      const r = await criar(api, oq).grupos();
      expect(r).toEqual({ fonte: 'openquery', itens: [{ GRP_CODIGO: 2, GRP_DESCRICAO: 'B' }] });
    });

    it('vai direto ao OPENQUERY sem ERP_API_URL', async () => {
      const api = fonte('api');
      const oq = fonte('openquery');
      const r = await criar(api, oq, false).grupos();
      expect(r.fonte).toBe('openquery');
      expect(api.grupos).not.toHaveBeenCalled();
    });

    it('limite excedido vira 400 e não dispara o fallback', async () => {
      const api = fonte('api', { notasPorPeriodo: jest.fn().mockRejectedValue(new LimiteExcedidoError('demais')) });
      const oq = fonte('openquery');
      await expect(
        criar(api, oq).notas({ data_inicial: '2026-10-01', data_final: '2026-10-10', operacoes: ['1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(oq.notasPorPeriodo).not.toHaveBeenCalled();
    });
  });

  describe('conciliar modo grupo', () => {
    it('calcula a diferença sobre disponível + reservado e tira os zerados nas duas empresas', async () => {
      const api = fonte('api', {
        produtosGerencial: jest.fn().mockResolvedValue([
          produto(1, { ESTOQUE_DISPONIVEL: 10, ESTOQUE_RESERVADO: 2 }),
          produto(2),
          produto(3, { ESTOQUE_DISPONIVEL: 5 }),
        ]),
        saldosFiscal: jest.fn().mockResolvedValue([
          { PRO_CODIGO: 1, ESTOQUE_DISPONIVEL: 8, ESTOQUE_RESERVADO: 1 },
          { PRO_CODIGO: 2, ESTOQUE_DISPONIVEL: 0, ESTOQUE_RESERVADO: 0 },
        ]),
      });
      const r = await criar(api, fonte('openquery')).conciliar({ modo: 'grupo', subgrupos: [1] });

      expect(r.itens.map((l) => l.PRO_CODIGO)).toEqual([1, 3]);
      expect(r.itens[0]).toMatchObject({ DIFERENCA: 3, SEM_CADASTRO_FISCAL: false });
      expect(r.itens[1]).toMatchObject({ DIFERENCA: 5, SEM_CADASTRO_FISCAL: true, E1_DISPONIVEL: 0 });
      expect(r.itens[0].QTD_MOVIMENTADA).toBeUndefined();
    });

    it('exige grupo ou subgrupo', async () => {
      await expect(criar(fonte('api'), fonte('openquery')).conciliar({ modo: 'grupo' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('junta a segunda localização de APLICACOES na mesma linha', async () => {
      const api = fonte('api', {
        produtosGerencial: jest
          .fn()
          .mockResolvedValue([produto(1, { ESTOQUE_DISPONIVEL: 1, LOCALIZACAO: 'vm202a01', APLICACOES: 'fica no BOX 03' })]),
      });
      const r = await criar(api, fonte('openquery')).conciliar({ modo: 'grupo', grupos: [1] });
      expect(r.itens[0].LOCALIZACOES).toEqual(['vm202a01', 'BOX 03']);
    });
  });

  describe('conciliar modo venda', () => {
    it('desconta a devolução, ignora venda cancelada e lista os NFS do produto', async () => {
      const itensDasNotas = jest.fn().mockResolvedValue([
        { NFS: 10, PRO_CODIGO: 1, QUANTIDADE: 3, QTDE_DEVOLVIDA: 1, OPF_CODIGO: '1' },
        { NFS: 11, PRO_CODIGO: 1, QUANTIDADE: 2, QTDE_DEVOLVIDA: 0, OPF_CODIGO: '1' },
      ]);
      const api = fonte('api', {
        notasPorNfs: jest.fn().mockResolvedValue([
          { NFS: 10, STATUS: 2, DT_CANCELAMENTO: null },
          { NFS: 11, STATUS: 1, DT_CANCELAMENTO: null },
          { NFS: 12, STATUS: 3, DT_CANCELAMENTO: null },
          { NFS: 14, STATUS: 0, DT_CANCELAMENTO: null },
        ]),
        itensDasNotas,
        produtosGerencial: jest.fn().mockResolvedValue([produto(1, { ESTOQUE_DISPONIVEL: 4 })]),
        saldosFiscal: jest.fn().mockResolvedValue([{ PRO_CODIGO: 1, ESTOQUE_DISPONIVEL: 4, ESTOQUE_RESERVADO: 0 }]),
      });

      const r = await criar(api, fonte('openquery')).conciliar({ modo: 'venda', nfs: [10, 11, 12, 13, 14] });

      expect(itensDasNotas).toHaveBeenCalledWith([10, 11]);
      expect(r.itens).toHaveLength(1);
      expect(r.itens[0]).toMatchObject({ QTD_MOVIMENTADA: 4, NFS: [10, 11], DIFERENCA: 0 });
      expect(r.itens[0].OPERACOES).toBeUndefined();
      expect(r.avisos).toEqual([
        'Vendas não encontradas: 13',
        'Vendas canceladas ignoradas: 12',
        'Vendas com STATUS fora de 1/2 ignoradas: 14',
      ]);
    });
  });

  describe('conciliar modo operacao', () => {
    it('soma a quantidade como positiva e lista as operações', async () => {
      const api = fonte('api', {
        itensDasNotas: jest.fn().mockResolvedValue([
          { NFS: 20, PRO_CODIGO: 7, QUANTIDADE: 2, QTDE_DEVOLVIDA: 2, OPF_CODIGO: '1' },
          { NFS: 21, PRO_CODIGO: 7, QUANTIDADE: -1, QTDE_DEVOLVIDA: 0, OPF_CODIGO: '2' },
        ]),
        produtosGerencial: jest.fn().mockResolvedValue([produto(7)]),
      });
      const r = await criar(api, fonte('openquery')).conciliar({ modo: 'operacao', nfs: '20,21' });
      expect(r.itens[0]).toMatchObject({ QTD_MOVIMENTADA: 3, NFS: [20, 21], OPERACOES: ['1', '2'] });
    });
  });

  describe('lerPeriodo', () => {
    it('aceita até 90 dias', () => {
      expect(lerPeriodo('2026-01-01', '2026-03-31')).toEqual({ data_inicial: '2026-01-01', data_final: '2026-03-31' });
    });

    it('recusa mais de 90 dias e data final antes da inicial', () => {
      expect(() => lerPeriodo('2026-01-01', '2026-04-01')).toThrow(BadRequestException);
      expect(() => lerPeriodo('2026-02-01', '2026-01-01')).toThrow(BadRequestException);
    });
  });
});
