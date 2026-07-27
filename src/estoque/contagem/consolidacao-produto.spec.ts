import { consolidarProdutoDia } from './consolidacao-produto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Cenário base (o que motivou a consolidação):
 * produto 38677, locações C1306B02 (sessão A, piso do corredor) e VM601B02 (sessão B,
 * vitrine móvel). Estoque total do sistema = 18.
 */
describe('consolidarProdutoDia', () => {
    const DATA = new Date('2026-07-27T00:00:00.000Z');

    const ITEM_C13 = {
        id: 'item-c13',
        contagem_cuid: 'sessao-A',
        localizacao: 'C1306B02',
        identificador_item: '38677-2026-07-27',
        estoque: 18,
    };

    const ITEM_VM = {
        id: 'item-vm',
        contagem_cuid: 'sessao-B',
        localizacao: 'VM601B02',
        identificador_item: '38677-2026-07-27-v2',
        estoque: 18,
    };

    function montarPrisma(opts: {
        itens: any[];
        cuidsAtivos: string[];
        logs: Array<{ item_id: string; contado: number; estoque?: number; rodada: number; status?: number }>;
    }): PrismaService {
        return {
            est_contagem_itens: {
                findMany: jest.fn().mockResolvedValue(opts.itens),
            },
            est_contagem: {
                findMany: jest.fn().mockResolvedValue(opts.cuidsAtivos.map(c => ({ contagem_cuid: c }))),
            },
            est_contagem_log: {
                findMany: jest.fn().mockResolvedValue(
                    opts.logs.map(l => ({
                        item_id: l.item_id,
                        contado: l.contado,
                        estoque: l.estoque ?? 18,
                        contagem: { contagem: l.rodada, status: l.status ?? 0 },
                    })),
                ),
            },
        } as unknown as PrismaService;
    }

    it('dá o produto como correto quando uma rodada inteira fecha somando as duas locações', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13, ITEM_VM],
            cuidsAtivos: ['sessao-A', 'sessao-B'],
            logs: [
                { item_id: 'item-c13', contado: 18, rodada: 1 },
                { item_id: 'item-vm', contado: 0, rodada: 1 },
                // A sessão B seguiu para a 2ª/3ª porque, sozinha, não fechava.
                { item_id: 'item-vm', contado: 0, rodada: 2 },
                { item_id: 'item-vm', contado: 0, rodada: 3 },
            ],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado).not.toBeNull();
        expect(consolidado!.estoque_referencia).toBe(18);
        expect(consolidado!.rodadas[1].cobertura_total).toBe(true);
        expect(consolidado!.rodadas[1].total).toBe(18);
        expect(consolidado!.rodadas[1].bate).toBe(true);
        expect(consolidado!.correto).toBe(true);
        expect(consolidado!.itens_ids).toEqual(['item-c13', 'item-vm']);
        expect(consolidado!.cuids).toEqual(['sessao-A', 'sessao-B']);
    });

    it('dá o produto como correto quando cada locação acertou numa rodada diferente', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13, ITEM_VM],
            cuidsAtivos: ['sessao-A', 'sessao-B'],
            logs: [
                // Nenhuma rodada tem as duas locações, mas a última contagem de cada uma fecha.
                { item_id: 'item-c13', contado: 18, rodada: 1 },
                { item_id: 'item-vm', contado: 0, rodada: 3 },
            ],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.rodadas[1].cobertura_total).toBe(false);
        expect(consolidado!.rodadas[3].cobertura_total).toBe(false);
        expect(consolidado!.todas_locacoes_contadas).toBe(true);
        expect(consolidado!.total_ultima_contagem).toBe(18);
        expect(consolidado!.correto).toBe(true);
        expect(consolidado!.motivo).toContain('última contagem de cada locação');
    });

    it('mantém a divergência quando a soma das locações não fecha com o estoque', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13, ITEM_VM],
            cuidsAtivos: ['sessao-A', 'sessao-B'],
            logs: [
                { item_id: 'item-c13', contado: 15, rodada: 1 },
                { item_id: 'item-vm', contado: 0, rodada: 1 },
            ],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.rodadas[1].cobertura_total).toBe(true);
        expect(consolidado!.rodadas[1].total).toBe(15);
        expect(consolidado!.correto).toBe(false);
        expect(consolidado!.motivo).toBeNull();
    });

    it('não fecha o produto enquanto uma das locações não foi contada', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13, ITEM_VM],
            cuidsAtivos: ['sessao-A', 'sessao-B'],
            logs: [{ item_id: 'item-c13', contado: 18, rodada: 1 }],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.todas_locacoes_contadas).toBe(false);
        expect(consolidado!.rodadas[1].cobertura_total).toBe(false);
        expect(consolidado!.correto).toBe(false);
    });

    it('ignora locações de sessões canceladas', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13, ITEM_VM],
            cuidsAtivos: ['sessao-A'], // sessão B foi excluída
            logs: [{ item_id: 'item-c13', contado: 18, rodada: 1 }],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.locacoes).toHaveLength(1);
        expect(consolidado!.rodadas[1].bate).toBe(true);
        expect(consolidado!.correto).toBe(true);
    });

    it('soma os logs de usuários diferentes na mesma rodada e locação', async () => {
        const prisma = montarPrisma({
            itens: [ITEM_C13],
            cuidsAtivos: ['sessao-A'],
            logs: [
                { item_id: 'item-c13', contado: 10, rodada: 1 },
                { item_id: 'item-c13', contado: 8, rodada: 1 },
            ],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.rodadas[1].total).toBe(18);
        expect(consolidado!.correto).toBe(true);
    });

    it('usa o estoque informado (tempo real) no lugar do snapshot gravado', async () => {
        const prisma = montarPrisma({
            itens: [{ ...ITEM_C13, estoque: 18 }],
            cuidsAtivos: ['sessao-A'],
            logs: [{ item_id: 'item-c13', contado: 20, rodada: 1 }],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA, { estoqueReferencia: 20 });

        expect(consolidado!.estoque_referencia).toBe(20);
        expect(consolidado!.correto).toBe(true);
    });

    it('compara cada rodada com o estoque vigente quando ela foi contada', async () => {
        // A 1ª contagem fechou os 18 que existiam na hora; depois houve venda e o estoque
        // do item foi atualizado para 15. A 1ª contagem continua correta.
        const prisma = montarPrisma({
            itens: [{ ...ITEM_C13, estoque: 15 }],
            cuidsAtivos: ['sessao-A'],
            logs: [{ item_id: 'item-c13', contado: 18, rodada: 1, estoque: 18 }],
        });

        const consolidado = await consolidarProdutoDia(prisma, 38677, DATA);

        expect(consolidado!.estoque_referencia).toBe(15);
        expect(consolidado!.rodadas[1].estoque_referencia).toBe(18);
        expect(consolidado!.rodadas[1].bate).toBe(true);
        expect(consolidado!.correto).toBe(true);
    });

    it('retorna null quando não há item do produto no dia', async () => {
        const prisma = montarPrisma({ itens: [], cuidsAtivos: [], logs: [] });

        expect(await consolidarProdutoDia(prisma, 38677, DATA)).toBeNull();
    });
});
