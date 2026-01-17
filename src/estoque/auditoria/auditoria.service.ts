import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EstoqueSaidasService } from '../contagem/contagem.service';

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
        const systemUser = await this.prisma.sis_usuarios.findFirst();

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
                }
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

            // Calcular saldo snapshot 
            // CORREÇÃO: O saldo 'estoque' em cada item já é o saldo TOTAL do sistema naquele momento.
            // Não devemos somar (pois duplicaria por locação), e sim pegar o de referência (primeiro).
            const estoqueSnapshot = groupItems.length > 0 ? groupItems[0].estoque : 0;

            // Estoque Atual Real do Sistema
            const estoqueAtualInfo = await this.contagemService.getEstoqueProduto(cod_produto);
            const estoqueAtual = estoqueAtualInfo?.ESTOQUE ?? null;

            const diferencas = {
                1: history[1].total - estoqueSnapshot,
                2: history[2].total - estoqueSnapshot,
                3: history[3].total - estoqueSnapshot,
            };

            // AUTO-AUDITORIA: Se a 3ª contagem bateu (diferença 0), auditoria automática.
            if (diferencas[3] === 0 && !audetado && mainCuid && systemUser) {
                // Criar auditoria automática
                const autoAudit = await this.prisma.est_auditoria.create({
                    data: {
                        contagem_cuid: mainCuid,
                        cod_produto: cod_produto,
                        diferenca_apontada: 0,
                        tipo_movimento: 'CORRETO',
                        quantidade_movimento: 0,
                        observacao: "Terceira contagem correta",
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
                ja_auditado: !!audetado,
                audit_id: audetado?.id
            });
        }

        return result;
    }

    async saveAuditoria(dto: {
        contagem_cuid: string;
        cod_produto: number;
        tipo_movimento: 'BAIXA' | 'INCLUSAO' | 'CORRETO';
        quantidade_movimento: number;
        observacao: string;
        usuario_id: string;
    }) {
        let diferenca_final = 0;
        if (dto.tipo_movimento === 'BAIXA') {
            diferenca_final = -Math.abs(dto.quantidade_movimento);
        } else if (dto.tipo_movimento === 'INCLUSAO') {
            diferenca_final = Math.abs(dto.quantidade_movimento);
        } else {
            diferenca_final = 0;
        }

        const saved = await this.prisma.est_auditoria.create({
            data: {
                contagem_cuid: dto.contagem_cuid,
                cod_produto: dto.cod_produto,
                diferenca_apontada: diferenca_final,
                tipo_movimento: dto.tipo_movimento,
                quantidade_movimento: Math.abs(dto.quantidade_movimento),
                observacao: dto.observacao,
                usuario_id: dto.usuario_id,
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
