import { PrismaService } from '../../prisma/prisma.service';

/**
 * CONSOLIDAÇÃO DE UM PRODUTO/DIA ENTRE TODAS AS LOCAÇÕES.
 *
 * Um mesmo produto pode estar em várias locações e — quando as locações ficam em pisos
 * diferentes — essas locações caem em SESSÕES de contagem diferentes (contagem_cuid
 * diferente e, por consequência, identificador_item diferente). A validação antiga só
 * enxergava as locações da própria sessão, então:
 *
 *   - a sessão que concluía primeiro somava só a SUA locação, não fechava com o estoque
 *     total do sistema e era liberada para a 2ª/3ª contagem;
 *   - a sessão que contava a outra locação depois fechava certo e parava na 1ª;
 *   - o resultado era um produto com a 1ª contagem correta e a 2ª/3ª "erradas" caindo
 *     na auditoria.
 *
 * Este helper olha o produto/dia INTEIRO (todas as locações, de todas as sessões ativas)
 * e responde se ele já foi contado corretamente.
 *
 * REGRA: rodadas NÃO se misturam. A validação soma 1ª com 1ª, 2ª com 2ª e 3ª com 3ª —
 * nunca a 3ª de uma locação com a 2ª de outra. O produto só fecha quando UMA rodada
 * inteira (todas as locações contadas naquela rodada) bate com o estoque vigente dela.
 */

export const RODADAS = [1, 2, 3] as const;
export type Rodada = (typeof RODADAS)[number];

export interface LocacaoConsolidada {
    item_id: string;
    contagem_cuid: string;
    localizacao: string | null;
    identificador_item: string | null;
    /** Locação fora do escopo da sessão (avulsa): aguarda uma contagem complementar. */
    pendente: boolean;
    /** Total contado por rodada nesta locação (null = não contada naquela rodada). */
    por_rodada: Record<Rodada, number | null>;
    /** Rodada mais recente em que a locação foi contada. */
    ultima_rodada: Rodada | null;
    /** Quantidade contada na última rodada em que a locação foi contada. */
    ultima_qtd: number;
}

export interface RodadaConsolidada {
    /** Soma do que foi contado na rodada, somando TODAS as locações do produto/dia. */
    total: number;
    locacoes_contadas: number;
    /** true quando todas as locações do produto/dia foram contadas nesta rodada. */
    cobertura_total: boolean;
    /** Estoque vigente quando a rodada foi contada (o estoque muda durante o dia). */
    estoque_referencia: number;
    /** true quando a rodada é completa E a soma fecha com o estoque daquela rodada. */
    bate: boolean;
}

export interface ConsolidadoProdutoDia {
    cod_produto: number;
    estoque_referencia: number;
    /** IDs de est_contagem_itens de TODAS as locações/sessões deste produto/dia. */
    itens_ids: string[];
    /** CUIDs das sessões envolvidas. */
    cuids: string[];
    locacoes: LocacaoConsolidada[];
    rodadas: Record<Rodada, RodadaConsolidada>;
    /**
     * Soma da ÚLTIMA contagem de cada locação (rodadas possivelmente diferentes).
     * APENAS INFORMATIVO — não valida o produto: rodadas não se misturam.
     */
    total_ultima_contagem: number;
    todas_locacoes_contadas: boolean;
    /** Produto fechado com o estoque -> não precisa seguir para as próximas contagens. */
    correto: boolean;
    /**
     * Estado consolidado em três valores:
     *  - 'correto': fechou com o estoque.
     *  - 'aguardando_pendentes': as locações do escopo foram contadas, mas o produto tem
     *    locações marcadas como pendentes (avulsa parcial) ainda sem contagem. Sem elas a
     *    soma não pode ser comparada ao estoque total — não é divergência.
     *  - 'divergente': dá para validar (não há pendente sem contagem segurando a soma) e
     *    a conta não fecha, ou alguém pulou uma locação do escopo.
     */
    status: 'correto' | 'aguardando_pendentes' | 'divergente';
    /** Locações pendentes (fora do escopo) que ainda não foram contadas. */
    locacoes_pendentes_nao_contadas: string[];
    motivo: string | null;
}

function limitesDoDia(data: Date): { inicio: Date; fim: Date } {
    const inicio = new Date(data);
    inicio.setUTCHours(0, 0, 0, 0);
    const fim = new Date(data);
    fim.setUTCHours(23, 59, 59, 999);
    return { inicio, fim };
}

function rodadaValida(valor: number): valor is Rodada {
    return valor === 1 || valor === 2 || valor === 3;
}

/**
 * Monta a visão consolidada de um produto/dia.
 *
 * @param estoqueReferencia força o estoque usado na comparação (ex.: valor recém-buscado
 *        em tempo real no ERP). Quando omitido, usa o maior snapshot gravado nos itens —
 *        e, se todos estiverem zerados, o maior snapshot gravado nos logs. Escolher o
 *        MAIOR é o lado seguro: na dúvida o produto continua sendo tratado como divergente
 *        e vai para o auditor, em vez de ser silenciosamente dado como correto.
 *
 * @returns null quando não há nenhum item ativo para o produto/dia.
 */
export async function consolidarProdutoDia(
    prisma: PrismaService,
    codProduto: number,
    data: Date,
    opts: { estoqueReferencia?: number } = {},
): Promise<ConsolidadoProdutoDia | null> {
    const { inicio, fim } = limitesDoDia(data);

    const itens = await prisma.est_contagem_itens.findMany({
        where: {
            cod_produto: codProduto,
            data: { gte: inicio, lte: fim },
        },
        select: {
            id: true,
            contagem_cuid: true,
            localizacao: true,
            identificador_item: true,
            estoque: true,
            pendente: true,
        },
    });

    if (itens.length === 0) return null;

    // Sessões canceladas (status != 0) não representam locação que alguém ainda vai
    // contar — se entrassem na conta, o produto nunca fecharia.
    const cuids = [...new Set(itens.map(i => i.contagem_cuid).filter((c): c is string => !!c))];
    const sessoesAtivas = cuids.length
        ? await prisma.est_contagem.findMany({
            where: { contagem_cuid: { in: cuids }, status: 0 },
            select: { contagem_cuid: true },
        })
        : [];
    const cuidsAtivos = new Set(
        sessoesAtivas.map(s => s.contagem_cuid).filter((c): c is string => !!c),
    );

    const itensAtivos = itens.filter(i => cuidsAtivos.has(i.contagem_cuid));
    if (itensAtivos.length === 0) return null;

    const itensIds = itensAtivos.map(i => i.id);

    const logs = await prisma.est_contagem_log.findMany({
        where: { item_id: { in: itensIds } },
        select: {
            item_id: true,
            contado: true,
            estoque: true,
            contagem: { select: { contagem: true, status: true } },
        },
    });

    const logsValidos = logs.filter(
        l => l.contagem && l.contagem.status === 0 && rodadaValida(l.contagem.contagem),
    );

    // ---- Estoque de referência ----
    let estoqueReferencia: number;
    if (typeof opts.estoqueReferencia === 'number' && Number.isFinite(opts.estoqueReferencia)) {
        estoqueReferencia = opts.estoqueReferencia;
    } else {
        const snapshotsItens = itensAtivos.map(i => i.estoque).filter(n => Number.isFinite(n) && n > 0);
        const snapshotsLogs = logsValidos.map(l => l.estoque).filter(n => Number.isFinite(n) && n > 0);
        if (snapshotsItens.length > 0) estoqueReferencia = Math.max(...snapshotsItens);
        else if (snapshotsLogs.length > 0) estoqueReferencia = Math.max(...snapshotsLogs);
        else estoqueReferencia = 0;
    }

    // ---- Soma por locação x rodada ----
    // Uma locação pode ter mais de um log na mesma rodada (um por usuário) -> soma.
    const somaPorItemRodada = new Map<string, Map<Rodada, number>>();
    const estoquePorRodada = new Map<Rodada, number[]>();
    for (const log of logsValidos) {
        const rodada = log.contagem.contagem as Rodada;
        let porRodada = somaPorItemRodada.get(log.item_id);
        if (!porRodada) {
            porRodada = new Map<Rodada, number>();
            somaPorItemRodada.set(log.item_id, porRodada);
        }
        porRodada.set(rodada, (porRodada.get(rodada) ?? 0) + log.contado);

        if (Number.isFinite(log.estoque) && log.estoque > 0) {
            const estoques = estoquePorRodada.get(rodada) ?? [];
            estoques.push(log.estoque);
            estoquePorRodada.set(rodada, estoques);
        }
    }

    const locacoes: LocacaoConsolidada[] = itensAtivos.map(item => {
        const porRodadaMap = somaPorItemRodada.get(item.id);
        const por_rodada = { 1: null, 2: null, 3: null } as Record<Rodada, number | null>;

        let ultima_rodada: Rodada | null = null;
        for (const rodada of RODADAS) {
            const valor = porRodadaMap?.get(rodada);
            if (valor === undefined) continue;
            por_rodada[rodada] = valor;
            ultima_rodada = rodada;
        }

        return {
            item_id: item.id,
            contagem_cuid: item.contagem_cuid,
            localizacao: item.localizacao,
            identificador_item: item.identificador_item,
            pendente: item.pendente,
            por_rodada,
            ultima_rodada,
            ultima_qtd: ultima_rodada ? (por_rodada[ultima_rodada] ?? 0) : 0,
        };
    });

    // ---- Visão por rodada ----
    // Cada rodada é comparada com o estoque que estava valendo QUANDO ela foi contada
    // (gravado no log). Sem isso, uma venda no meio do dia transformaria uma contagem
    // correta da 1ª rodada em divergência ao ser reavaliada mais tarde.
    const rodadas = {} as Record<Rodada, RodadaConsolidada>;
    for (const rodada of RODADAS) {
        const contadas = locacoes.filter(l => l.por_rodada[rodada] !== null);
        const total = contadas.reduce((acc, l) => acc + (l.por_rodada[rodada] ?? 0), 0);
        const cobertura_total = contadas.length > 0 && contadas.length === locacoes.length;

        const estoquesDaRodada = estoquePorRodada.get(rodada) ?? [];
        const estoqueDaRodada = estoquesDaRodada.length
            ? Math.max(...estoquesDaRodada)
            : estoqueReferencia;

        rodadas[rodada] = {
            total,
            locacoes_contadas: contadas.length,
            cobertura_total,
            estoque_referencia: estoqueDaRodada,
            bate: cobertura_total && total === estoqueDaRodada,
        };
    }

    // ---- Visão "última contagem de cada locação" ----
    // Só para exibição (auditoria mostra a soma mais recente de cada locação). NÃO
    // valida o produto: misturar a 3ª de uma locação com a 2ª de outra daria como
    // certo um produto que nenhuma rodada inteira confirmou.
    const todas_locacoes_contadas = locacoes.every(l => l.ultima_rodada !== null);
    const total_ultima_contagem = locacoes.reduce((acc, l) => acc + l.ultima_qtd, 0);

    // O produto só fecha quando UMA rodada completa (todas as locações contadas
    // naquela mesma rodada) soma o estoque vigente dela.
    const rodadaQueBateu = RODADAS.find(r => rodadas[r].bate) ?? null;
    const correto = !!rodadaQueBateu;

    // Pendente sem contagem NÃO é locação pulada: é locação deliberadamente deixada para
    // uma avulsa complementar. Enquanto houver uma, a soma é parcial por definição e o
    // produto não pode ser dado nem como certo nem como divergente.
    const pendentesNaoContadas = locacoes.filter(l => l.pendente && l.ultima_rodada === null);
    const escopoTodoContado = locacoes
        .filter(l => !l.pendente)
        .every(l => l.ultima_rodada !== null);
    const aguardandoPendentes = !correto && pendentesNaoContadas.length > 0 && escopoTodoContado;

    let motivo: string | null = null;
    if (rodadaQueBateu) {
        motivo = `${rodadaQueBateu}ª contagem fechou com o estoque somando todas as locações`;
    } else if (aguardandoPendentes) {
        motivo = `Aguardando contagem das locações pendentes: ${pendentesNaoContadas
            .map(l => l.localizacao ?? 'sem locação')
            .join(', ')}`;
    }

    return {
        cod_produto: codProduto,
        estoque_referencia: estoqueReferencia,
        itens_ids: itensIds,
        cuids: [...new Set(itensAtivos.map(i => i.contagem_cuid))],
        locacoes,
        rodadas,
        total_ultima_contagem,
        todas_locacoes_contadas,
        correto,
        status: correto ? 'correto' : aguardandoPendentes ? 'aguardando_pendentes' : 'divergente',
        locacoes_pendentes_nao_contadas: pendentesNaoContadas.map(l => l.localizacao ?? ''),
        motivo,
    };
}
