import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EstoqueSaidasService } from '../contagem/contagem.service';
import { consolidarProdutoDia } from '../contagem/consolidacao-produto';

@Injectable()
export class AuditoriaService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly contagemService: EstoqueSaidasService,
    ) { }

    async getItensParaAuditoria(data: string, piso?: string) {
        const startDate = new Date(data);
        startDate.setUTCHours(0, 0, 0, 0);
        const endDate = new Date(data);
        endDate.setUTCHours(23, 59, 59, 999);

        // Se filtrar por piso, buscar os CUIDs das contagens desse piso primeiro
        let filterCuids: string[] | undefined;

        if (piso) {
            const contagensPiso = await this.prisma.est_contagem.findMany({
                where: {
                    created_at: { gte: startDate, lte: endDate },
                    piso: piso
                },
                select: { contagem_cuid: true }
            });
            // Filtrar apenas CUIDs válidos
            filterCuids = contagensPiso.map(c => c.contagem_cuid).filter((c): c is string => c !== null);

            // Se filtrou por piso e não achou nada, retorna vazio direto
            if (filterCuids.length === 0) return [];
        }

        const whereClause: any = {
            data: { gte: startDate, lte: endDate },
            conferir: true,
        };

        if (filterCuids) {
            whereClause.contagem_cuid = { in: filterCuids };
        }

        // 1. Buscar Itens com Divergência na data (conferir=true)
        const itensComDivergencia = await this.prisma.est_contagem_itens.findMany({
            where: whereClause,
            select: { cod_produto: true },
            distinct: ['cod_produto']
        });

        if (itensComDivergencia.length === 0) return [];

        const produtosComDivergencia = itensComDivergencia.map(i => i.cod_produto);

        // 2. Buscar TODOS os itens desses produtos na data (independente de CUID ou conferir)
        const todosItens = await this.prisma.est_contagem_itens.findMany({
            where: {
                data: { gte: startDate, lte: endDate },
                cod_produto: { in: produtosComDivergencia }
            },
            select: {
                id: true,
                cod_produto: true,
                desc_produto: true,
                localizacao: true,
                estoque: true,
                contagem_cuid: true,
                identificador_item: true,
                data: true,
            },
        });

        // 3. Agrupar items por Produto (apenas)
        const itemsByProduct: Record<number, typeof todosItens> = {};

        for (const item of todosItens) {
            if (!itemsByProduct[item.cod_produto]) itemsByProduct[item.cod_produto] = [];
            itemsByProduct[item.cod_produto].push(item);
        }

        const result: any[] = [];

        // Buscar um usuário do sistema para auto-auditoria uma única vez
        // Buscar um usuário do sistema para auto-auditoria
        let systemUser = await this.prisma.sis_usuarios.findFirst({
            where: { nome: 'SISTEMA' }
        });

        if (!systemUser) {
            systemUser = await this.prisma.sis_usuarios.findFirst();
        }

        for (const codProdutoStr in itemsByProduct) {
            const cod_produto = Number(codProdutoStr);
            const groupItems = itemsByProduct[cod_produto];
            const firstItem = groupItems[0];
            const { desc_produto } = firstItem;

            const cuidsEnvolvidos = [...new Set(groupItems.map(i => i.contagem_cuid))];

            // Só sessões DIÁRIAS (tipo 1) contam aqui: uma avulsa criada com 3 rodadas
            // também tem "3ª fechada" e, sem o filtro, o produto dela caía na auditoria
            // por data além da tela própria da avulsa (que consolida as sessões
            // vinculadas — é lá que ele deve ser auditado).
            const contagensFechadas = await this.prisma.est_contagem.findMany({
                where: {
                    contagem_cuid: { in: cuidsEnvolvidos },
                    contagem: 3,
                    liberado_contagem: false,
                    status: 0,
                    tipo: 1
                },
                select: {
                    contagem_cuid: true,
                    piso: true
                }
            });

            if (contagensFechadas.length === 0) {
                continue;
            }

            const mainCuid = contagensFechadas[0].contagem_cuid;

            // Verificar se já foi auditado
            let audetado = await this.prisma.est_auditoria.findFirst({
                where: {
                    cod_produto: cod_produto,
                    contagem_cuid: { in: cuidsEnvolvidos },
                    status: 1
                },
                orderBy: { created_at: 'desc' }
            });

            // Montar Histórico Consolidado
            const itemIds = groupItems.map(i => i.id);

            const history = {
                1: { total: 0, logs: [] as any[] },
                2: { total: 0, logs: [] as any[] },
                3: { total: 0, logs: [] as any[] },
            };

            const allLogs = await this.prisma.est_contagem_log.findMany({
                where: { item_id: { in: itemIds } },
                include: {
                    contagem: { select: { contagem: true, colaborador: true, usuario: { select: { nome: true } } } },
                    item: { select: { localizacao: true } }
                }
            });

            allLogs.forEach(log => {
                const nivel = log.contagem.contagem;
                if (history[nivel]) {
                    history[nivel].logs.push({
                        usuario: log.contagem.usuario.nome,
                        qtd: log.contado,
                        local: log.item.localizacao,
                        data: log.created_at
                    });
                    history[nivel].total += log.contado;
                }
            });

            // CONSOLIDAÇÃO POR PRODUTO/DIA (todas as locações, de todas as sessões).
            // É o que resolve o produto multilocação: a locação A pode ter fechado certo
            // na 1ª contagem e a locação B só ter aparecido depois — a auditoria precisa
            // enxergar a soma das locações, não cada sessão isoladamente.
            const consolidado = await consolidarProdutoDia(this.prisma, cod_produto, firstItem.data);

            // Calcular saldo snapshot
            // CORREÇÃO: O saldo 'estoque' em cada item já é o saldo TOTAL do sistema naquele momento.
            // Não devemos somar (pois duplicaria por locação), e sim pegar o de referência (primeiro).
            const estoqueSnapshot = consolidado?.estoque_referencia
                ?? (groupItems.length > 0 ? groupItems[0].estoque : 0);

            // Estoque Atual Real do Sistema
            const estoqueAtualInfo = await this.contagemService.getEstoqueProduto(cod_produto);
            const estoqueAtual = estoqueAtualInfo?.ESTOQUE ?? null;

            const diferencas = {
                1: history[1].total - estoqueSnapshot,
                2: history[2].total - estoqueSnapshot,
                3: history[3].total - estoqueSnapshot,
            };

            // Última rodada em que o produto foi de fato contado: é ela que decide a
            // diferença exibida/validada — rodada sem registro compararia zero contra
            // o estoque e acusaria divergência falsa.
            const ultimaRodadaContada = ([3, 2, 1] as const)
                .find(r => history[r].logs.length > 0) ?? null;

            // AUTO-AUDITORIA: o produto é dado como correto quando uma rodada INTEIRA
            // fechou somando todas as locações (rodadas nunca se misturam), ou quando a
            // última rodada CONTADA bateu com o estoque (rodada sem registro não decide).
            const motivoCorreto = consolidado?.correto
                ? consolidado.motivo
                : (ultimaRodadaContada !== null && diferencas[ultimaRodadaContada] === 0
                    ? `${ultimaRodadaContada}ª contagem (última contada) fechou com o estoque`
                    : null);

            if (motivoCorreto && !audetado && mainCuid && systemUser) {
                // Criar auditoria automática
                const autoAudit = await this.prisma.est_auditoria.create({
                    data: {
                        contagem_cuid: mainCuid,
                        cod_produto: cod_produto,
                        diferenca_apontada: 0,
                        tipo_movimento: 'CORRETO',
                        quantidade_movimento: 0,
                        observacao: motivoCorreto,
                        usuario_id: systemUser.id,
                        status: 1
                    }
                }).catch(e => {
                    console.error("Erro ao gerar auto-auditoria", e);
                    return null;
                });

                if (autoAudit) {
                    audetado = autoAudit;
                }
            }

            // Buscar o piso da contagem principal
            const contagemPrincipal = contagensFechadas.find(c => c.contagem_cuid === mainCuid);
            const piso = contagemPrincipal?.piso || null;

            result.push({
                contagem_cuid: mainCuid,
                cod_produto,
                desc_produto,
                estoque_snapshot: estoqueSnapshot,
                estoque_atual: estoqueAtual,
                locacoes: groupItems.map(g => g.localizacao),
                piso: piso,
                history,
                diferencas,
                ultima_rodada_contada: ultimaRodadaContada,
                diferenca_final: diferencas[(ultimaRodadaContada ?? 3) as 1 | 2 | 3],
                // Visão consolidada das locações (inclusive as de outras sessões/pisos):
                // permite o front explicar por que o produto foi dado como correto.
                consolidado: consolidado ? {
                    correto: consolidado.correto,
                    motivo: consolidado.motivo,
                    estoque_referencia: consolidado.estoque_referencia,
                    total_ultima_contagem: consolidado.total_ultima_contagem,
                    todas_locacoes_contadas: consolidado.todas_locacoes_contadas,
                    locacoes: consolidado.locacoes.map(l => ({
                        localizacao: l.localizacao,
                        contagem_cuid: l.contagem_cuid,
                        por_rodada: l.por_rodada,
                        ultima_rodada: l.ultima_rodada,
                        ultima_qtd: l.ultima_qtd,
                    })),
                    rodadas: consolidado.rodadas,
                } : null,
                ja_auditado: !!audetado,
                audit_id: audetado?.id,
                audit_dados: audetado ? {
                    tipo: audetado.tipo_movimento,
                    qtd: audetado.quantidade_movimento,
                    obs: audetado.observacao
                } : null
            });
        }

        // 4. Verificação de Recorrência de Erro (Pós-processamento ou dentro do loop anterior se otimizado)
        // Como o loop acima já é pesado, vamos fazer uma query extra leve para cada item ou buscar em lote se possível.
        // Vamos iterar o result para preencher a flag 'recorrencia_erro'.
        for (const item of result) {
            const ultimasAuditorias = await this.prisma.est_auditoria.findMany({
                where: {
                    cod_produto: item.cod_produto,
                    status: 1
                },
                orderBy: { created_at: 'desc' },
                take: 3,
                select: { tipo_movimento: true }
            });

            // Se tiver qualquer apontamento de BAIXA ou INCLUSAO nas ultimas 3
            const temErroRecorrente = ultimasAuditorias.some(a =>
                a.tipo_movimento === 'BAIXA' || a.tipo_movimento === 'INCLUSAO'
            );

            (item as any).recorrencia_erro = temErroRecorrente;
        }

        return result;
    }

    /**
     * Lista as contagens AVULSAS para o seletor da auditoria.
     *
     * A auditoria por data não serve para a avulsa: ela exige a 3ª rodada fechada (a
     * avulsa pode ter só a 1ª) e não diz de qual contagem o produto veio. Aqui cada
     * sessão avulsa vira uma linha com o retrato do que a auditoria vai encontrar:
     * quantos produtos, quantos divergentes, quantos aguardando locações pendentes e
     * se a contagem já foi concluída.
     */
    async listarAvulsasParaAuditoria() {
        const rodadas = await this.prisma.est_contagem.findMany({
            where: { tipo: 2, status: 0, contagem_cuid: { not: null } },
            select: {
                contagem_cuid: true,
                contagem: true,
                liberado_contagem: true,
                piso: true,
                created_at: true,
                data_fim: true,
            },
            orderBy: { created_at: 'desc' },
        });

        if (rodadas.length === 0) return [];

        // Agrupa as rodadas (1/2/3) de cada sessão.
        const porCuid = new Map<string, typeof rodadas>();
        for (const r of rodadas) {
            const cuid = r.contagem_cuid as string;
            const grupo = porCuid.get(cuid);
            if (grupo) grupo.push(r);
            else porCuid.set(cuid, [r]);
        }

        const cuids = [...porCuid.keys()];
        const itens = await this.prisma.est_contagem_itens.findMany({
            where: { contagem_cuid: { in: cuids } },
            select: {
                contagem_cuid: true,
                cod_produto: true,
                conferir: true,
                pendente: true,
                data: true,
                logs: { select: { id: true }, take: 1 },
            },
        });

        const resumoPorCuid = new Map<string, {
            produtos: Set<number>;
            divergentes: Set<number>;
            aguardando: Set<number>;
            dataItens: Date | null;
            chavesProdutoDia: Set<string>;
        }>();
        for (const item of itens) {
            let resumo = resumoPorCuid.get(item.contagem_cuid);
            if (!resumo) {
                resumo = { produtos: new Set(), divergentes: new Set(), aguardando: new Set(), dataItens: null, chavesProdutoDia: new Set() };
                resumoPorCuid.set(item.contagem_cuid, resumo);
            }
            resumo.produtos.add(item.cod_produto);
            if (item.conferir && !item.pendente) resumo.divergentes.add(item.cod_produto);
            if (item.pendente && item.logs.length === 0) resumo.aguardando.add(item.cod_produto);
            if (!resumo.dataItens || item.data < resumo.dataItens) resumo.dataItens = item.data;
            resumo.chavesProdutoDia.add(`${item.cod_produto}-${item.data.toISOString().slice(0, 10)}`);
        }

        // SESSÕES VINCULADAS aparecem UMA vez: duas avulsas que compartilham um
        // produto/dia (a que deixou a pendência e a que a adotou) são a mesma
        // contagem aos olhos da auditoria. Union-find pelo produto/dia.
        const pai = new Map<string, string>();
        const find = (x: string): string => {
            let raiz = x;
            while (pai.get(raiz) !== raiz) raiz = pai.get(raiz) as string;
            // compressão de caminho
            let atual = x;
            while (pai.get(atual) !== raiz) {
                const proximo = pai.get(atual) as string;
                pai.set(atual, raiz);
                atual = proximo;
            }
            return raiz;
        };
        const unir = (a: string, b: string) => { pai.set(find(a), find(b)); };

        for (const cuid of cuids) pai.set(cuid, cuid);
        const cuidPorChave = new Map<string, string>();
        for (const [cuid, resumo] of resumoPorCuid) {
            for (const chave of resumo.chavesProdutoDia) {
                const dono = cuidPorChave.get(chave);
                if (dono) unir(cuid, dono);
                else cuidPorChave.set(chave, cuid);
            }
        }

        const gruposVinculados = new Map<string, string[]>();
        for (const cuid of cuids) {
            const raiz = find(cuid);
            const grupo = gruposVinculados.get(raiz);
            if (grupo) grupo.push(cuid);
            else gruposVinculados.set(raiz, [cuid]);
        }

        const result: any[] = [];
        for (const membros of gruposVinculados.values()) {
            // Sessão principal = a mais antiga do grupo (a origem da contagem).
            const sessoes = membros
                .map(cuid => {
                    const rodadas = porCuid.get(cuid) ?? [];
                    const rodada1 = rodadas.find(g => g.contagem === 1) ?? rodadas[0];
                    return { cuid, rodadas, rodada1 };
                })
                .sort((a, b) => (a.rodada1?.created_at?.getTime() ?? 0) - (b.rodada1?.created_at?.getTime() ?? 0));

            const principal = sessoes[0];
            const nomes = [...new Set(sessoes.map(s => s.rodada1?.piso).filter((p): p is string => !!p))];

            const produtos = new Set<number>();
            const divergentes = new Set<number>();
            const aguardando = new Set<number>();
            let dataItens: Date | null = null;
            for (const s of sessoes) {
                const resumo = resumoPorCuid.get(s.cuid);
                if (!resumo) continue;
                resumo.produtos.forEach(p => produtos.add(p));
                resumo.divergentes.forEach(p => divergentes.add(p));
                resumo.aguardando.forEach(p => aguardando.add(p));
                if (resumo.dataItens && (!dataItens || resumo.dataItens < dataItens)) dataItens = resumo.dataItens;
            }

            // Concluída = TODAS as sessões do grupo com 1ª rodada finalizada e nenhuma
            // rodada aberta.
            const concluida = sessoes.every(
                s => !!s.rodada1?.data_fim && !s.rodadas.some(g => g.liberado_contagem),
            );

            result.push({
                contagem_cuid: principal.cuid,
                nome: nomes[0] ?? null,
                // Nomes das sessões vinculadas (além da principal), sem repetição.
                vinculadas: nomes.slice(1),
                total_sessoes: sessoes.length,
                created_at: principal.rodada1?.created_at ?? null,
                data_itens: dataItens,
                total_produtos: produtos.size,
                produtos_divergentes: divergentes.size,
                produtos_aguardando: aguardando.size,
                concluida,
            });
        }

        // Mais recentes primeiro (mesma ordem que a listagem de sessões tinha).
        result.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
        return result;
    }

    /**
     * Auditoria de UMA contagem avulsa, consolidando as sessões vinculadas.
     *
     * O vínculo entre sessões é o produto/dia: a sessão que deixou locações pendentes e
     * a(s) que as adotaram compartilham itens do mesmo produto na mesma data — a
     * consolidação enxerga todas. Cada produto sai com um de três estados:
     *  - divergente: auditável (formulário liberado);
     *  - aguardando locações pendentes: ainda não dá para validar — aparece marcado,
     *    sem formulário;
     *  - correto: recebe auto-auditoria "CORRETO" (como no fluxo por data), desde que a
     *    contagem esteja concluída.
     */
    async getItensParaAuditoriaAvulsa(contagemCuid: string) {
        if (!contagemCuid?.trim()) {
            throw new BadRequestException('Informe a contagem avulsa (contagem_cuid).');
        }

        const rodadasSessao = await this.prisma.est_contagem.findMany({
            where: { contagem_cuid: contagemCuid, status: 0 },
            select: { contagem: true, piso: true },
        });
        if (rodadasSessao.length === 0) return [];

        const rodada1 = rodadasSessao.find(r => r.contagem === 1) ?? rodadasSessao[0];

        // Fecho transitivo das sessões vinculadas: parte da selecionada e vai puxando as
        // avulsas ativas que compartilham produto/dia (quem deixou pendência e quem a
        // adotou), até estabilizar. Como o seletor mostra o grupo UMA vez só, a auditoria
        // precisa cobrir os produtos de todas as sessões do grupo — não só da principal.
        //
        // O fecho avança POR SESSÃO, em lote: uma avulsa grande tem centenas de
        // produtos, e duas consultas por item não terminam dentro do tempo da
        // requisição — a tela abortava e a contagem "sumia" da auditoria.
        const grupos = new Map<string, { cod_produto: number; desc_produto: string; data: Date }>();
        const cuidsVisitados = new Set<string>([contagemCuid]);
        const fila: string[] = [contagemCuid];

        const chaveDe = (cod: number, data: Date) => `${cod}-${data.toISOString().slice(0, 10)}`;

        while (fila.length > 0) {
            const cuidAtual = fila.shift() as string;
            const itensDaSessao = await this.prisma.est_contagem_itens.findMany({
                where: { contagem_cuid: cuidAtual },
                select: { cod_produto: true, desc_produto: true, data: true },
            });

            const novos: typeof itensDaSessao = [];
            for (const item of itensDaSessao) {
                const chave = chaveDe(item.cod_produto, item.data);
                if (grupos.has(chave)) continue;
                grupos.set(chave, { cod_produto: item.cod_produto, desc_produto: item.desc_produto, data: item.data });
                novos.push(item);
            }
            if (novos.length === 0) continue;

            // Irmãos de TODOS os produtos/dia novos numa consulta só: faixa de datas
            // min..max + recorte exato por chave em memória.
            let minIni: Date | null = null;
            let maxFim: Date | null = null;
            for (const item of novos) {
                const ini = new Date(item.data);
                ini.setUTCHours(0, 0, 0, 0);
                const fim = new Date(item.data);
                fim.setUTCHours(23, 59, 59, 999);
                if (!minIni || ini < minIni) minIni = ini;
                if (!maxFim || fim > maxFim) maxFim = fim;
            }
            const chavesNovas = new Set(novos.map(n => chaveDe(n.cod_produto, n.data)));

            const irmaos = await this.prisma.est_contagem_itens.findMany({
                where: {
                    cod_produto: { in: [...new Set(novos.map(n => n.cod_produto))] },
                    data: { gte: minIni!, lte: maxFim! },
                },
                select: { contagem_cuid: true, cod_produto: true, data: true },
            });

            const cuidsCandidatos = new Set<string>();
            for (const i of irmaos) {
                if (!i.contagem_cuid || cuidsVisitados.has(i.contagem_cuid)) continue;
                if (!chavesNovas.has(chaveDe(i.cod_produto, i.data))) continue;
                cuidsCandidatos.add(i.contagem_cuid);
            }

            if (cuidsCandidatos.size > 0) {
                const avulsasAtivas = await this.prisma.est_contagem.findMany({
                    where: { contagem_cuid: { in: [...cuidsCandidatos] }, tipo: 2, status: 0 },
                    select: { contagem_cuid: true },
                });
                for (const s of avulsasAtivas) {
                    if (s.contagem_cuid && !cuidsVisitados.has(s.contagem_cuid)) {
                        cuidsVisitados.add(s.contagem_cuid);
                        fila.push(s.contagem_cuid);
                    }
                }
            }
        }

        if (grupos.size === 0) return [];

        // Grupo concluído = TODAS as sessões do fecho com a 1ª rodada finalizada e
        // nenhuma rodada aberta. É essa a régua da auto-auditoria e do bloqueio "em
        // andamento" — a sessão selecionada pode ter acabado enquanto uma vinculada
        // ainda conta.
        const rodadasGrupo = await this.prisma.est_contagem.findMany({
            where: { contagem_cuid: { in: [...cuidsVisitados] }, status: 0 },
            select: { contagem_cuid: true, contagem: true, liberado_contagem: true, data_fim: true, piso: true },
        });
        const rodadasPorCuid = new Map<string, typeof rodadasGrupo>();
        for (const r of rodadasGrupo) {
            if (!r.contagem_cuid) continue;
            const lista = rodadasPorCuid.get(r.contagem_cuid);
            if (lista) lista.push(r);
            else rodadasPorCuid.set(r.contagem_cuid, [r]);
        }
        const grupoConcluido = [...rodadasPorCuid.values()].every(rodadas => {
            const r1 = rodadas.find(r => r.contagem === 1) ?? rodadas[0];
            return !!r1?.data_fim && !rodadas.some(r => r.liberado_contagem);
        });

        // Quantas rodadas o grupo TEM (a avulsa escolhe 1 a 3 na criação): é a régua
        // de exibição/decisão das diferenças — a "diferença final" é a da última
        // rodada existente, não a da 3ª.
        const totalRodadasGrupo = Math.min(3, Math.max(1, ...rodadasGrupo.map(r => r.contagem)));

        // Nome (piso) da rodada 1 de cada sessão do fecho — para "sessões vinculadas".
        const nomePorCuid = new Map<string, string | null>();
        for (const [cuid, rodadas] of rodadasPorCuid) {
            const r1 = rodadas.find(r => r.contagem === 1) ?? rodadas[0];
            nomePorCuid.set(cuid, r1?.piso ?? null);
        }

        let systemUser = await this.prisma.sis_usuarios.findFirst({ where: { nome: 'SISTEMA' } });
        if (!systemUser) {
            systemUser = await this.prisma.sis_usuarios.findFirst();
        }

        const codigosProdutos = [...new Set([...grupos.values()].map(g => g.cod_produto))];

        // Estoque atual em LOTE de verdade (`PRO_CODIGO:em:...`, 500 por consulta):
        // a lista inteira é conhecida de antemão, então não há razão para uma
        // requisição por produto. Estoque atual é informativo na tela — falha
        // aqui não pode derrubar a auditoria, os produtos só ficam sem o valor.
        const estoquePorProduto = new Map<number, number | null>();
        try {
            const saldoPorProduto = await this.contagemService.getEstoquePorProdutos(codigosProdutos);
            for (const cod of codigosProdutos) {
                estoquePorProduto.set(cod, saldoPorProduto.get(cod) ?? null);
            }
        } catch (e) {
            console.error('[AUDITORIA] Falha ao buscar estoque atual em lote; itens seguem sem o valor.', e);
            for (const cod of codigosProdutos) estoquePorProduto.set(cod, null);
        }

        // Auditorias existentes em LOTE (mais recente primeiro por produto); o filtro
        // fino por cuids envolvidos acontece no laço. Auto-auditorias criadas nesta
        // chamada entram na frente da lista — a recorrência as enxerga como antes.
        const auditoriasTodas = await this.prisma.est_auditoria.findMany({
            where: { cod_produto: { in: codigosProdutos }, status: 1 },
            orderBy: { created_at: 'desc' },
        });
        const auditoriasPorProduto = new Map<number, typeof auditoriasTodas>();
        for (const a of auditoriasTodas) {
            const lista = auditoriasPorProduto.get(a.cod_produto);
            if (lista) lista.push(a);
            else auditoriasPorProduto.set(a.cod_produto, [a]);
        }

        const result: any[] = [];

        for (const grupo of grupos.values()) {
            const consolidado = await consolidarProdutoDia(this.prisma, grupo.cod_produto, grupo.data);
            if (!consolidado) continue;

            const cuidsEnvolvidos = consolidado.cuids;

            // Sessões vinculadas = as outras sessões que têm locações deste produto/dia
            // (quem deixou a pendência ou quem a adotou). Nomes já pré-buscados.
            const outrasSessoes = cuidsEnvolvidos.filter(c => c !== contagemCuid);
            const sessoesVinculadas = [...new Set(
                outrasSessoes
                    .map(c => nomePorCuid.get(c))
                    .filter((p): p is string => !!p),
            )];

            // Histórico consolidado: logs de TODAS as locações do produto/dia, de todas
            // as sessões vinculadas — é o que torna a auditoria da avulsa correta.
            const history = {
                1: { total: 0, logs: [] as any[] },
                2: { total: 0, logs: [] as any[] },
                3: { total: 0, logs: [] as any[] },
            };

            const allLogs = await this.prisma.est_contagem_log.findMany({
                where: { item_id: { in: consolidado.itens_ids } },
                include: {
                    contagem: { select: { contagem: true, colaborador: true, usuario: { select: { nome: true } } } },
                    item: { select: { localizacao: true } },
                },
            });

            allLogs.forEach(log => {
                const nivel = log.contagem.contagem;
                if (history[nivel]) {
                    history[nivel].logs.push({
                        usuario: log.contagem.usuario.nome,
                        qtd: log.contado,
                        local: log.item.localizacao,
                        data: log.created_at,
                    });
                    history[nivel].total += log.contado;
                }
            });

            const estoqueSnapshot = consolidado.estoque_referencia;
            const estoqueAtual = estoquePorProduto.get(grupo.cod_produto) ?? null;

            const diferencas = {
                1: history[1].total - estoqueSnapshot,
                2: history[2].total - estoqueSnapshot,
                3: history[3].total - estoqueSnapshot,
            };

            // Última rodada em que ESTE produto foi de fato contado. O grupo pode ter
            // 3 rodadas e o produto ter registros só na 1ª (ex.: locação pendente
            // adotada por uma avulsa de menos rodadas): validar pela rodada do grupo
            // compararia zero contra o estoque e acusaria divergência falsa.
            const ultimaRodadaContada = ([3, 2, 1] as const)
                .find(r => history[r].logs.length > 0) ?? null;
            const rodadaFinal = (ultimaRodadaContada ?? totalRodadasGrupo) as 1 | 2 | 3;

            // Mais recente restrita aos cuids envolvidos (lista já vem em ordem desc).
            let audetado = (auditoriasPorProduto.get(grupo.cod_produto) ?? [])
                .find(a => cuidsEnvolvidos.includes(a.contagem_cuid)) ?? null;

            const aguardandoPendentes = consolidado.status === 'aguardando_pendentes';

            // Produto correto: uma rodada inteira fechou (regra da consolidação) OU a
            // última rodada CONTADA fechou com o estoque. O segundo caso cobre o
            // produto multi-sessão em que a recontagem não repassa toda locação (a que
            // ficou de fora vale zero na rodada) — a soma da rodada final batendo com o
            // estoque é o veredito, e sem isso o item nunca sai da fila da auditoria.
            const corretoPelaRodadaFinal =
                ultimaRodadaContada !== null && !aguardandoPendentes && diferencas[ultimaRodadaContada] === 0;

            // Auto-auditoria CORRETO: só quando o GRUPO todo foi concluído — antes disso
            // o resultado ainda pode mudar.
            if ((consolidado.correto || corretoPelaRodadaFinal) && grupoConcluido && !audetado && systemUser) {
                const autoAudit = await this.prisma.est_auditoria.create({
                    data: {
                        contagem_cuid: contagemCuid,
                        cod_produto: grupo.cod_produto,
                        diferenca_apontada: 0,
                        tipo_movimento: 'CORRETO',
                        quantidade_movimento: 0,
                        observacao: consolidado.motivo
                            ?? `${rodadaFinal}ª contagem (última contada) fechou com o estoque`,
                        usuario_id: systemUser.id,
                        status: 1,
                    },
                }).catch(e => {
                    console.error('Erro ao gerar auto-auditoria (avulsa)', e);
                    return null;
                });
                if (autoAudit) {
                    audetado = autoAudit;
                    // Entra na frente da lista pré-buscada: a recorrência (abaixo) deve
                    // enxergar a auto-auditoria recém-criada, como no fluxo antigo.
                    const lista = auditoriasPorProduto.get(grupo.cod_produto);
                    if (lista) lista.unshift(autoAudit);
                    else auditoriasPorProduto.set(grupo.cod_produto, [autoAudit]);
                }
            }

            result.push({
                contagem_cuid: contagemCuid,
                cod_produto: grupo.cod_produto,
                desc_produto: grupo.desc_produto,
                estoque_snapshot: estoqueSnapshot,
                estoque_atual: estoqueAtual,
                locacoes: consolidado.locacoes.map(l => l.localizacao),
                piso: rodada1?.piso ?? null,
                history,
                diferencas,
                consolidado: {
                    correto: consolidado.correto,
                    status: consolidado.status,
                    motivo: consolidado.motivo,
                    estoque_referencia: consolidado.estoque_referencia,
                    total_ultima_contagem: consolidado.total_ultima_contagem,
                    todas_locacoes_contadas: consolidado.todas_locacoes_contadas,
                    locacoes: consolidado.locacoes.map(l => ({
                        localizacao: l.localizacao,
                        contagem_cuid: l.contagem_cuid,
                        pendente: l.pendente,
                        por_rodada: l.por_rodada,
                        ultima_rodada: l.ultima_rodada,
                        ultima_qtd: l.ultima_qtd,
                    })),
                    rodadas: consolidado.rodadas,
                },
                aguardando_pendentes: aguardandoPendentes,
                locacoes_pendentes: consolidado.locacoes_pendentes_nao_contadas,
                sessoes_vinculadas: sessoesVinculadas,
                contagem_concluida: grupoConcluido,
                // Régua das diferenças: o grupo tem 1 a 3 rodadas (escolhidas na
                // criação da avulsa), mas quem decide é a última rodada em que o
                // produto FOI CONTADO — rodada sem registro não valida nada.
                total_rodadas: totalRodadasGrupo,
                ultima_rodada_contada: ultimaRodadaContada,
                diferenca_final: diferencas[rodadaFinal],
                ja_auditado: !!audetado,
                audit_id: audetado?.id,
                audit_dados: audetado ? {
                    tipo: audetado.tipo_movimento,
                    qtd: audetado.quantidade_movimento,
                    obs: audetado.observacao,
                } : null,
            });
        }

        // Recorrência de erro — mesma régua do fluxo por data, sobre a lista já
        // pré-buscada (com as auto-auditorias desta chamada na frente).
        for (const item of result) {
            const ultimasAuditorias = (auditoriasPorProduto.get(item.cod_produto) ?? []).slice(0, 3);
            item.recorrencia_erro = ultimasAuditorias.some(a =>
                a.tipo_movimento === 'BAIXA' || a.tipo_movimento === 'INCLUSAO',
            );
        }

        return result;
    }

    async saveAuditoria(dto: {
        contagem_cuid: string;
        cod_produto: number;
        tipo_movimento: 'BAIXA' | 'INCLUSAO' | 'CORRETO';
        quantidade_movimento: number;
        observacao: string;
        usuario_id?: string;
    }, userIdHeader?: string) {
        let diferenca_final = 0;
        if (dto.tipo_movimento === 'BAIXA') {
            diferenca_final = -Math.abs(dto.quantidade_movimento);
        } else if (dto.tipo_movimento === 'INCLUSAO') {
            diferenca_final = Math.abs(dto.quantidade_movimento);
        } else {
            diferenca_final = 0;
        }

        const resolvedUsuarioId = (userIdHeader || dto.usuario_id || '').trim();
        if (!resolvedUsuarioId) {
            throw new BadRequestException('Usuário auditor é obrigatório.');
        }

        const usuarioExiste = await this.prisma.sis_usuarios.findUnique({
            where: { id: resolvedUsuarioId },
            select: { id: true },
        });

        if (!usuarioExiste) {
            throw new BadRequestException('Usuário auditor inválido.');
        }

        const saved = await this.prisma.est_auditoria.create({
            data: {
                contagem_cuid: dto.contagem_cuid,
                cod_produto: dto.cod_produto,
                diferenca_apontada: diferenca_final,
                tipo_movimento: dto.tipo_movimento,
                quantidade_movimento: Math.abs(dto.quantidade_movimento),
                observacao: dto.observacao,
                usuario_id: resolvedUsuarioId,
                status: 1
            }
        });
        return saved;
    }

    async getHistorico(codProduto: number) {
        return this.prisma.est_auditoria.findMany({
            where: { cod_produto: codProduto, status: 1 },
            include: { usuario: { select: { nome: true } } },
            orderBy: { created_at: 'desc' }
        });
    }
}
