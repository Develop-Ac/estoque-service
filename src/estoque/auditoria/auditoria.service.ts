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

            const contagensFechadas = await this.prisma.est_contagem.findMany({
                where: {
                    contagem_cuid: { in: cuidsEnvolvidos },
                    contagem: 3,
                    liberado_contagem: false,
                    status: 0
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

            // AUTO-AUDITORIA: o produto é dado como correto quando QUALQUER etapa fechou —
            // uma rodada inteira somando todas as locações, ou a última contagem de cada
            // locação (mesmo que cada uma tenha acertado numa rodada diferente).
            const motivoCorreto = consolidado?.correto
                ? consolidado.motivo
                : (diferencas[3] === 0 ? 'Terceira contagem correta' : null);

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
        }>();
        for (const item of itens) {
            let resumo = resumoPorCuid.get(item.contagem_cuid);
            if (!resumo) {
                resumo = { produtos: new Set(), divergentes: new Set(), aguardando: new Set(), dataItens: null };
                resumoPorCuid.set(item.contagem_cuid, resumo);
            }
            resumo.produtos.add(item.cod_produto);
            if (item.conferir && !item.pendente) resumo.divergentes.add(item.cod_produto);
            if (item.pendente && item.logs.length === 0) resumo.aguardando.add(item.cod_produto);
            if (!resumo.dataItens || item.data < resumo.dataItens) resumo.dataItens = item.data;
        }

        const result: any[] = [];
        for (const [cuid, grupo] of porCuid) {
            const rodada1 = grupo.find(g => g.contagem === 1) ?? grupo[0];
            const resumo = resumoPorCuid.get(cuid);

            // Concluída = a 1ª rodada tem fim registrado e nenhuma rodada segue aberta.
            const concluida = !!rodada1?.data_fim && !grupo.some(g => g.liberado_contagem);

            result.push({
                contagem_cuid: cuid,
                nome: rodada1?.piso ?? null,
                created_at: rodada1?.created_at ?? null,
                data_itens: resumo?.dataItens ?? null,
                total_produtos: resumo?.produtos.size ?? 0,
                produtos_divergentes: resumo?.divergentes.size ?? 0,
                produtos_aguardando: resumo?.aguardando.size ?? 0,
                concluida,
            });
        }

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
            select: { contagem: true, liberado_contagem: true, data_fim: true, piso: true },
        });
        if (rodadasSessao.length === 0) return [];

        const rodada1 = rodadasSessao.find(r => r.contagem === 1) ?? rodadasSessao[0];
        const sessaoConcluida = !!rodada1?.data_fim && !rodadasSessao.some(r => r.liberado_contagem);

        const itensSessao = await this.prisma.est_contagem_itens.findMany({
            where: { contagem_cuid: contagemCuid },
            select: { id: true, cod_produto: true, desc_produto: true, data: true, estoque: true },
        });
        if (itensSessao.length === 0) return [];

        // Agrupa por produto/dia — a mesma chave da consolidação.
        const grupos = new Map<string, { cod_produto: number; desc_produto: string; data: Date }>();
        for (const item of itensSessao) {
            const chave = `${item.cod_produto}-${item.data.toISOString().slice(0, 10)}`;
            if (!grupos.has(chave)) {
                grupos.set(chave, { cod_produto: item.cod_produto, desc_produto: item.desc_produto, data: item.data });
            }
        }

        let systemUser = await this.prisma.sis_usuarios.findFirst({ where: { nome: 'SISTEMA' } });
        if (!systemUser) {
            systemUser = await this.prisma.sis_usuarios.findFirst();
        }

        const result: any[] = [];

        for (const grupo of grupos.values()) {
            const consolidado = await consolidarProdutoDia(this.prisma, grupo.cod_produto, grupo.data);
            if (!consolidado) continue;

            const cuidsEnvolvidos = consolidado.cuids;

            // Sessões vinculadas = as outras sessões que têm locações deste produto/dia
            // (quem deixou a pendência ou quem a adotou).
            const outrasSessoes = cuidsEnvolvidos.filter(c => c !== contagemCuid);
            let sessoesVinculadas: string[] = [];
            if (outrasSessoes.length > 0) {
                const vinculadas = await this.prisma.est_contagem.findMany({
                    where: { contagem_cuid: { in: outrasSessoes }, contagem: 1, status: 0 },
                    select: { piso: true },
                });
                sessoesVinculadas = vinculadas
                    .map(v => v.piso)
                    .filter((p): p is string => !!p);
            }

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
            const estoqueAtualInfo = await this.contagemService.getEstoqueProduto(grupo.cod_produto);
            const estoqueAtual = estoqueAtualInfo?.ESTOQUE ?? null;

            const diferencas = {
                1: history[1].total - estoqueSnapshot,
                2: history[2].total - estoqueSnapshot,
                3: history[3].total - estoqueSnapshot,
            };

            let audetado = await this.prisma.est_auditoria.findFirst({
                where: {
                    cod_produto: grupo.cod_produto,
                    contagem_cuid: { in: cuidsEnvolvidos },
                    status: 1,
                },
                orderBy: { created_at: 'desc' },
            });

            const aguardandoPendentes = consolidado.status === 'aguardando_pendentes';

            // Auto-auditoria CORRETO: só quando a contagem foi concluída — antes disso o
            // resultado ainda pode mudar.
            if (consolidado.correto && sessaoConcluida && !audetado && systemUser) {
                const autoAudit = await this.prisma.est_auditoria.create({
                    data: {
                        contagem_cuid: contagemCuid,
                        cod_produto: grupo.cod_produto,
                        diferenca_apontada: 0,
                        tipo_movimento: 'CORRETO',
                        quantidade_movimento: 0,
                        observacao: consolidado.motivo ?? 'Contagem fechou com o estoque',
                        usuario_id: systemUser.id,
                        status: 1,
                    },
                }).catch(e => {
                    console.error('Erro ao gerar auto-auditoria (avulsa)', e);
                    return null;
                });
                if (autoAudit) audetado = autoAudit;
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
                contagem_concluida: sessaoConcluida,
                ja_auditado: !!audetado,
                audit_id: audetado?.id,
                audit_dados: audetado ? {
                    tipo: audetado.tipo_movimento,
                    qtd: audetado.quantidade_movimento,
                    obs: audetado.observacao,
                } : null,
            });
        }

        // Recorrência de erro — mesma régua do fluxo por data.
        for (const item of result) {
            const ultimasAuditorias = await this.prisma.est_auditoria.findMany({
                where: { cod_produto: item.cod_produto, status: 1 },
                orderBy: { created_at: 'desc' },
                take: 3,
                select: { tipo_movimento: true },
            });
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
