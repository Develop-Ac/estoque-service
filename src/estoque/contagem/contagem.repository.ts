import { Injectable, BadRequestException } from '@nestjs/common';
import { OpenQueryService } from '../../shared/database/openquery/openquery.service';
import { EstoqueSaidaRow } from './contagem.types';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ConferirEstoqueResponseDto } from './dto/conferir-estoque-response.dto';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

// ==== helpers de saneamento (anti-NUL) ====
function stripNulls(s: string): string {
  // remove bytes NUL e normaliza
  return s.replace(/\u0000/g, '');
}

// Converte qualquer valor "texto" para string limpa ou null:
// aceita string, Buffer, e objeto { data: number[] } (ex.: vindo do Firebird)
function asCleanNullableText(v: any): string | null {
  if (v === undefined || v === null) return null;

  let s: string;
  if (Buffer.isBuffer(v)) {
    s = v.toString('utf8');
  } else if (typeof v === 'object' && Array.isArray((v as any).data)) {
    // ex.: { type: 'Buffer', data: [...] }
    s = Buffer.from((v as any).data).toString('utf8');
  } else {
    s = String(v);
  }

  s = stripNulls(s).trim();
  return s.length ? s : null;
}

function asCleanDate(v: any): Date {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

function asNumberOrZero(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Função auxiliar para extrair e validar locações
function formatAndValidateLocation(text: string | null): string | null {
  if (!text) return null;

  const upperApp = text.toUpperCase();

  // 1. Regras Especiais (Prioridade Alta)
  // BOX (ex: BOX 03, BOX 3, BOX BEBEDOR, BOX 1 CX 4)
  // Aceita digitos (com opcional CX N) OU a palavra especifica BEBEDOR
  const boxMatch = upperApp.match(/\bBOX\s*(?:BEBEDOR|\d+(?:\s+CX\s+\d+)?)\b/);
  if (boxMatch) {
    return `A-${boxMatch[0]}`;
  }

  // BOQUETA
  if (upperApp.includes('BOQUETA')) {
    return 'A-BOQUETA';
  }

  // CAIXA ESCADA / CX ESCADA
  if (upperApp.match(/\b(?:CX|CAIXA)\s*ESCADA\b/)) {
    return 'A-CX ESCADA';
  }



  // 3. Regra do Padrão: Letra + 2-4 Números + Letra + 1-2 Números
  // Ex: A1204E02, C16D1
  // Regex: \b[A-Z]\d{2,4}[A-Z]\d{1,2}\b (Case insensitive)
  const codeRegex = /\b[A-Z]\d{2,4}[A-Z]\d{1,2}\b/gi;
  const matches = text.match(codeRegex);

  if (matches && matches.length > 0) {
    // Junta todos os códigos encontrados com espaço
    return matches.join(' ');
  }

  // Se não caiu em nenhuma regra, considera lixo e retorna null
  return null;
}

/**
 * Responsável por montar o T-SQL dinâmico com OPENQUERY(CONSULTA, '...').
 * Observação: OPENQUERY exige string literal; portanto usamos um SQL externo dinâmico
 * que constrói a literal com as datas/empresa já escapadas.
 */
@Injectable()
export class EstoqueSaidasRepository {
  constructor(
    private readonly oq: OpenQueryService,
    private readonly prisma: PrismaService
  ) { }

  async fetchSaidas(params: {
    data_inicial: string; // YYYY-MM-DD
    data_final: string;   // YYYY-MM-DD
    empresa: string;      // '3' por default
    tipo?: number;        // 1=Diária, 2=Avulsa
  }): Promise<EstoqueSaidaRow[]> {
    const { data_inicial, data_final, empresa, tipo } = params;

    // Sanitização adicional (já validado no DTO, aqui é um "belt and suspenders"):
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_inicial) || !/^\d{4}-\d{2}-\d{2}$/.test(data_final)) {
      throw new BadRequestException('Datas devem ser YYYY-MM-DD');
    }
    if (!/^\d+$/.test(empresa)) {
      throw new BadRequestException('Empresa inválida');
    }

    // Monta o SQL que será passado DENTRO do OPENQUERY (dialeto Firebird).
    // Atenção às aspas: dentro de uma string T-SQL, aspas simples duplicam.
    const innerSql = [
      'SELECT',
      '    EST.data,',
      '    EST.pro_codigo as COD_PRODUTO,',
      '    PRO.pro_descricao AS DESC_PRODUTO,',
      '    MC.mar_descricao,',
      '    PRO.ref_fabricante,',
      '    PRO.ref_FORNECEDOR,',
      '    PRO.localizacao AS LOCALIZACAO,',
      '    PRO.unidade,',
      '    PRO.aplicacoes,',
      '    PRO.codigo_barras,',
      '    SUM(EST.quantidade) AS QTDE_SAIDA,',
      '    MAX(PRO.estoque_disponivel) AS ESTOQUE,',
      '    MAX(PRO.estoque_reservado) as RESERVA',
      'FROM lanctos_estoque EST',
      'JOIN PRODUTOS PRO',
      '    ON (EST.pro_codigo = PRO.pro_codigo)',
      '    AND (EST.empresa = PRO.empresa)',
      'JOIN MARCAS MC',
      '    ON (MC.EMPRESA = PRO.EMPRESA)',
      '    AND (MC.MAR_CODIGO = PRO.MAR_CODIGO)',
      `WHERE EST.empresa = '${empresa}'`,
      `    AND EST.data BETWEEN '${data_inicial}' AND '${data_final}'`,
      `    AND EST.origem not in ('NFE', 'CNE')`,
      'GROUP BY',
      '    EST.data,',
      '    EST.pro_codigo,',
      '    PRO.pro_descricao,',
      '    PRO.localizacao,',
      '    PRO.unidade,',
      '    PRO.aplicacoes,',
      '    PRO.codigo_barras,',
      '    MC.mar_descricao,',
      '    PRO.ref_fabricante,',
      '    PRO.ref_FORNECEDOR',
      'ORDER BY PRO.localizacao',
    ].join('\n');

    // Agora construímos o SQL EXTERNO (T-SQL) com OPENQUERY.
    // Precisamos dobrar aspas simples do innerSql para caber numa literal T-SQL.
    const innerEscaped = innerSql.replace(/'/g, "''");

    const outerSql = `
      /* estoque-saidas OPENQUERY */
      SELECT *
      FROM OPENQUERY(CONSULTA, '${innerEscaped}');
    `;

    // Executa via .query para retornar recordset
    const rows = await this.oq.query<EstoqueSaidaRow>(outerSql, {}, { timeout: 300_000 });

    const sanitizedRows = (rows ?? []).map((row, i) => {
      let txtApp: string | null;
      let txtLoc: string | null;

      try {
        // APLICA EXTRAÇÃO INTELIGENTE para APLICACOES:
        // Se for "HB20", retorna null. Se for "A1204E02", retorna "A1204E02".
        // Se for "BOX 03", retorna "A-BOX 03".
        txtApp = formatAndValidateLocation(this.toUtf8Text((row as any).APLICACOES));
      } catch (e) {
        console.error('Falha ao converter APLICACOES na linha', i, row?.COD_PRODUTO, e);
        txtApp = null;
      }

      try {
        // APLICA FORMATAÇÃO + EXTRAÇÃO para LOCALIZACAO:
        // O usuário quer que "BOX 03" vire "A-BOX 03" também no campo principal.
        // Se a função retornar null (ex: texto irrelevante ou formato desconhecido),
        // mantemos o valor original do banco (fallback), pois LOCALIZACAO é campo mestre.
        const rawLoc = this.toUtf8Text((row as any).LOCALIZACAO);
        const formattedLoc = formatAndValidateLocation(rawLoc);
        txtLoc = formattedLoc ?? rawLoc; // Se não validar/formatar, usa o original (confiança no ERP)
      } catch (e) {
        console.error('Falha ao converter LOCALIZACAO na linha', i, row?.COD_PRODUTO, e);
        txtLoc = (row as any).LOCALIZACAO;
      }

      return { ...row, APLICACOES: txtApp, LOCALIZACAO: txtLoc };
    });

    // Duplica os itens conforme solicitado APENAS SE TIPO = 2 (AVULSA)
    const result: EstoqueSaidaRow[] = [];
    for (const item of sanitizedRows) {
      result.push(item);

      // Só cria o segundo item se APLICACOES for válido (não nulo) E se for Tipo 2 (Avulsa)
      if (tipo === 2 && item.APLICACOES != null && item.APLICACOES.trim() !== '') {
        // Cria uma cópia do item, coloca APLICACOES na LOCALIZACAO e zera APLICACOES
        result.push({
          ...item,
          LOCALIZACAO: item.APLICACOES,
          APLICACOES: null
        });
      }
    }

    return result;
  }

  toUtf8Text(val: unknown): string | null {
    if (val == null) return null;                 // null/undefined
    if (typeof val === 'string') return val;      // já é string

    // Buffer (Node)
    if (Buffer.isBuffer(val)) return (val as Buffer).toString('utf-8');

    // Uint8Array / ArrayBuffer
    if (val instanceof Uint8Array) return Buffer.from(val).toString('utf-8');
    if (val instanceof ArrayBuffer) return Buffer.from(new Uint8Array(val)).toString('utf-8');

    // Objeto no formato { type: 'Buffer', data: number[] }
    const maybe = val as any;
    if (maybe?.type === 'Buffer' && Array.isArray(maybe?.data)) {
      return Buffer.from(maybe.data).toString('utf-8');
    }

    // Último recurso: tente stringify seguro
    try {
      return String(val);
    } catch {
      return null;
    }
  }



  async createContagem(createContagemDto: CreateContagemDto) {
    const {
      colaborador: nomeColaboradorRaw,
      contagem: tipoContagem,
      produtos,
      contagem_cuid,
      piso
    } = createContagemDto;

    // limpa possíveis NULs no nome
    const nomeColaborador = stripNulls(String(nomeColaboradorRaw ?? '')).trim();

    // Buscar o usuário pelo nome para obter o ID
    const usuario = await this.prisma.sis_usuarios.findFirst({
      where: {
        nome: nomeColaborador,
        trash: 0,
      },
    });

    if (!usuario) {
      throw new BadRequestException(`Colaborador com nome "${nomeColaborador}" não encontrado`);
    }

    // Gera um CUID único se não foi fornecido
    const grupoContagem = contagem_cuid || crypto.randomUUID();

    // Pré-sanitiza os produtos uma única vez
    const produtosSanitizados = Array.isArray(produtos)
      ? produtos.map((p) => ({
        DATA: asCleanDate(p.DATA),
        COD_PRODUTO: asNumberOrZero(p.COD_PRODUTO),
        DESC_PRODUTO: asCleanNullableText(p.DESC_PRODUTO),
        MAR_DESCRICAO: asCleanNullableText(p.MAR_DESCRICAO),
        REF_FABRICANTE: asCleanNullableText(p.REF_FABRICANTE),
        REF_FORNECEDOR: asCleanNullableText(p.REF_FORNECEDOR),
        LOCALIZACAO: (function () {
          const raw = asCleanNullableText(p.LOCALIZACAO);
          return formatAndValidateLocation(raw) ?? raw; // Formata se for especial, senão mantém original
        })(),
        UNIDADE: asCleanNullableText(p.UNIDADE),
        // EXTRAÇÃO INTELIGENTE DE APLICAÇÕES
        APLICACOES: formatAndValidateLocation(asCleanNullableText(p.APLICACOES)),
        QTDE_SAIDA: asNumberOrZero(p.QTDE_SAIDA),
        ESTOQUE: asNumberOrZero(p.ESTOQUE),
        RESERVA: asNumberOrZero(p.RESERVA),
      }))
      : [];

    // Usar transação para criar contagem e itens separadamente
    const contagemResult = await this.prisma.$transaction(async (tx) => {
      // Criar a contagem sem itens primeiro
      const contagem = await tx.est_contagem.create({
        data: {
          colaborador: usuario.id,
          contagem: tipoContagem,
          contagem_cuid: grupoContagem,
          // true se contagem for 1, false para demais valores
          liberado_contagem: tipoContagem === 1,
          piso: String(piso),
          tipo: createContagemDto.tipo || 1, // Salva o tipo (1=Diária, 2=Avulsa)
        },
        include: {
          usuario: {
            select: { id: true, nome: true, codigo: true },
          },
        },
      });

      // Verificar se já existem itens para este contagem_cuid
      const itensExistentes = await tx.est_contagem_itens.findMany({
        where: { contagem_cuid: grupoContagem },
      });

      let itens: any[] = [];

      if (itensExistentes.length === 0) {
        // Criar os itens associados ao contagem_cuid
        for (const produto of produtosSanitizados) {
          // Extrai apenas a data no formato yyyy-mm-dd
          const dataStr = produto.DATA instanceof Date
            ? produto.DATA.toISOString().slice(0, 10)
            : String(produto.DATA).slice(0, 10);

          // Lógica de Versionamento Automático (Slots de 2)
          // 1. Tenta o ID Base (v1)
          let targetIdentificador = `${produto.COD_PRODUTO}-${dataStr}`;
          let version = 1;

          // Loop para encontrar um identificador com slot livre (< 2 usos)
          while (true) {
            const usageCount = await tx.est_contagem_itens.count({
              where: { identificador_item: targetIdentificador }
            });

            if (usageCount < 2) {
              // Slot livre encontrado!
              break;
            }

            // Slot cheio (já existem 2 locais para este ID). Tenta próxima versão.
            version++;
            targetIdentificador = `${produto.COD_PRODUTO}-${dataStr}-v${version}`;
          }

          // Log de debug para confirmar versão gerada
          if (version > 1) {
            console.log(`[AUTO-VERSION] Produto ${produto.COD_PRODUTO} excedeu limite diário. Gerando versão: ${targetIdentificador}`);
          }

          const item = await tx.est_contagem_itens.create({
            data: {
              identificador_item: targetIdentificador, // Usando o ID versionado
              contagem_cuid: grupoContagem,
              data: produto.DATA, // salva apenas yyyy-mm-dd
              cod_produto: produto.COD_PRODUTO,
              desc_produto: produto.DESC_PRODUTO ?? '',
              mar_descricao: produto.MAR_DESCRICAO,
              ref_fabricante: produto.REF_FABRICANTE,
              ref_fornecedor: produto.REF_FORNECEDOR,
              localizacao: produto.LOCALIZACAO,
              unidade: produto.UNIDADE,
              aplicacoes: produto.APLICACOES,
              qtde_saida: produto.QTDE_SAIDA,
              estoque: produto.ESTOQUE,
              reserva: produto.RESERVA,
            },
          });
          itens.push(item);
        }
      } else {
        itens = itensExistentes;
      }

      return { ...contagem, itens };
    });

    return contagemResult;
  }

  async getContagensByUsuario(idUsuario: string) {
    // Verificar se o usuário existe
    const usuario = await this.prisma.sis_usuarios.findFirst({
      where: {
        id: idUsuario,
        trash: 0
      }
    });

    if (!usuario) {
      throw new BadRequestException(`Usuário com ID "${idUsuario}" não encontrado`);
    }

    // Buscar todas as contagens do usuário
    const contagens = await this.prisma.est_contagem.findMany({
      where: {
        colaborador: idUsuario
      },
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            codigo: true
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    // Buscar os itens separadamente usando contagem_cuid
    const contagensComItens = await Promise.all(
      contagens.map(async (contagem) => {
        if (contagem.contagem_cuid) {
          const itens = await this.prisma.est_contagem_itens.findMany({
            where: {
              contagem_cuid: contagem.contagem_cuid
            },
            orderBy: {
              cod_produto: 'asc'
            }
          });
          return { ...contagem, itens };
        }
        return { ...contagem, itens: [] };
      })
    );

    return contagensComItens;
  }

  async updateItemConferir(identificador_item: string, conferir: boolean, itemId: string) {

    // 1. Buscar o item de contagem para verificar se tem apicações
    const contagemItem = await this.prisma.est_contagem_itens.findUnique({
      where: { id: itemId }
    });

    if (!contagemItem) {
      throw new BadRequestException('Item de contagem não encontrado');
    }

    // 2. Buscar logs para este item, ordenados
    const logs = await this.prisma.est_contagem_log.findMany({
      where: { identificador_item: identificador_item },
      orderBy: { created_at: 'desc' }
    });

    // Filtra logs apenas da contagem atual (baseado no ultimo log ou similar, 
    // mas idealmente deveriamos ter o contagem_id. Vamos inferir do log mais recente se existir, 
    // ou assumir que se não tem logs, não tem divergência ainda).
    // Se não tem logs, usamos conferir default.
    if (logs.length === 0) {
      return await this.prisma.est_contagem_itens.update({
        where: { id: itemId },
        data: { conferir: conferir },
      });
    }

    // Precisamos identificar a "Contagem Atual" (Nível 1, 2 ou 3) e o CUID.
    // Usamos o primeiro log para buscar sua contagem pai.
    const latestLog = logs[0];
    const parentContagem = await this.prisma.est_contagem.findUnique({
      where: { id: latestLog.contagem_id }
    });

    if (!parentContagem) {
      // Fallback seguro se algo estiver inconsistente
      const currentContagemId = latestLog.contagem_id;
      const activeLogs = logs.filter(l => l.contagem_id === currentContagemId);
    }

    let activeLogs = logs;

    if (parentContagem) {
      // Busca TODOS os IDs de contagem irmãos (mesmo CUID e Nível)
      const siblingContagens = await this.prisma.est_contagem.findMany({
        where: {
          contagem_cuid: parentContagem.contagem_cuid,
          contagem: parentContagem.contagem
        },
        select: { id: true }
      });
      const siblingIds = siblingContagens.map(c => c.id);
      activeLogs = logs.filter(l => siblingIds.includes(l.contagem_id));
    } else {
      // Fallback: isola apenas pelo ID do log (comportamento antigo, menos ideal)
      activeLogs = logs.filter(l => l.contagem_id === latestLog.contagem_id);
    }

    // Calcular a SOMA REAL dos logs da contagem ATUAL
    // Como agora garantimos (no createLog) que existe 1 log POR USUÁRIO para a contagem,
    // basta somar os logs da contagem atual.

    // CORREÇÃO: Filtrar logs apenas para items associados ao MESMO identificador_item, 
    // mas que pertençam à contagem atual (mesmo grupo).
    // Como `identificador_item` é compartilhado por todas as localizações do mesmo produto/dia,
    const logsRelevantes = await this.prisma.est_contagem_log.findMany({
      where: {
        identificador_item: identificador_item,
        // Filtrar logs apenas da RODADA atual (1, 2 ou 3), independente do Grupo (CUID).
        contagem: {
          contagem: parentContagem?.contagem
        }
      }
    });

    const realSum = logsRelevantes.reduce((acc, log) => acc + log.contado, 0);

    const estoqueSnapshot = activeLogs.length > 0 ? activeLogs[0].estoque : (contagemItem.estoque || 0);

    console.log(`[DEBUG] updateItemConferir: Identificador=${identificador_item}`);
    console.log(`[DEBUG] updateItemConferir: ParentContagem=${parentContagem?.contagem_cuid} (Tipo ${parentContagem?.contagem})`);
    console.log(`[DEBUG] updateItemConferir: Logs Encontrados=${logsRelevantes.length}`);
    logsRelevantes.forEach(l => console.log(`   -> Log ID=${l.id} ItemID=${l.item_id} Qtd=${l.contado}`));
    console.log(`[DEBUG] updateItemConferir: SomaReal=${realSum} vs EstoqueSnapshot=${estoqueSnapshot}`);
    console.log(`[DEBUG] updateItemConferir: Divergencia? ${realSum !== estoqueSnapshot}`);

    // --- LÓGICA DE VALIDAÇÃO COM OPENQUERY ---
    // MODIFICADO: Buscar estoque REAL realtime para não depender do snapshot
    // Se falhar a busca (null), usamos o snapshot como fallback
    let estoqueRealtime = estoqueSnapshot;

    try {
      const produtoEstoque = await this.getEstoqueProduto(contagemItem.cod_produto);
      if (produtoEstoque) {
        estoqueRealtime = produtoEstoque.ESTOQUE;
        console.log(`[DEBUG] updateItemConferir: Estoque Realtime Obtido=${estoqueRealtime} (Snapshot era ${estoqueSnapshot})`);

        // NOVO: Persistir este estoque atualizado no item para "congelar" a referência
        // Isso evita que na finalização do grupo precisemos buscar de novo.
        await this.prisma.est_contagem_itens.update({
          where: { id: itemId },
          data: { estoque: estoqueRealtime }
        });

        // CORREÇÃO: Atualizar também os logs existentes para este item/contagem com o estoque real
        // Caso contrário, eles ficam com 0 se o front mandou 0 inicialmente.
        const logsToUpdate = logsRelevantes.map(l => l.id);
        if (logsToUpdate.length > 0) {
          await this.prisma.est_contagem_log.updateMany({
            where: { id: { in: logsToUpdate } },
            data: { estoque: estoqueRealtime }
          });
          console.log(`[DEBUG] Atualizado estoque=${estoqueRealtime} em ${logsToUpdate.length} logs relacionados.`);
        }
      }
    } catch (e) {
      console.error('[DEBUG] Falha ao buscar estoque realtime', e);
    }

    // Recalcular divergência com o estoque atualizado (Realtime ou Snapshot se falhou)
    const temDivergenciaNumerica = realSum !== estoqueRealtime;

    console.log(`[DEBUG] updateItemConferir: Divergencia Final? ${temDivergenciaNumerica} (RealSum=${realSum} vs EstoqueRef=${estoqueRealtime})`);

    // Se o usuário mandou "conferir: false", mas matematicamente tem divergência,
    // precisamos ter cuidado. 
    // O sistema original forçava o Back a decidir.

    // --- LÓGICA DE VALIDAÇÃO HÍBRIDA (FRONT x BACK) ---
    // 1. Buscar todos os itens que compõem este produto (mesmo identificador)
    const groupItems = await this.prisma.est_contagem_itens.findMany({
      where: {
        identificador_item: identificador_item,
        contagem_cuid: parentContagem?.contagem_cuid ?? ''
      }
    });

    let finalConferirValue = temDivergenciaNumerica; // Default: Back decide (segurança)
    let trustFront = false;

    if (groupItems.length <= 1) {
      // CASO 1: Locação Única -> CONFIA NO FRONT
      // O usuário sabe o que está vendo. Se ele marcou que tem divergência, tem. Se não, não.
      trustFront = true;
    } else {
      // CASO 2: Multilocação
      // Verificamos se TODOS os locais já foram contados nesta rodada.
      // Se ainda falta contagem em algum local, não temos como validar o total,
      // então confiamos no status provisório que o front mandar.

      const countedItemIds = new Set(logsRelevantes.map(l => l.item_id));
      const allLocationsCounted = groupItems.every(item => countedItemIds.has(item.id));

      if (!allLocationsCounted) {
        // Ainda não acabou de contar todos os locais -> CONFIA NO FRONT (Status Provisório)
        trustFront = true;
      } else {
        // Todos contados -> VALIDAÇÃO RIGOROSA DO BACK
        // Somamos tudo e vemos se bate com o estoque total.
        trustFront = false;
      }
    }

    if (trustFront) {
      console.log(`[DEBUG] HybridValidation: Trusting Frontend value=${conferir}`);
      finalConferirValue = conferir;
    } else {
      console.log(`[DEBUG] HybridValidation: Enforcing Backend value=${temDivergenciaNumerica}`);
      finalConferirValue = temDivergenciaNumerica;
    }

    // ATUALIZAÇÃO EM MASSA:
    const updated = await this.prisma.est_contagem_itens.updateMany({
      where: { identificador_item: identificador_item },
      data: { conferir: finalConferirValue },
    });

    // Retorna um dos itens atualizados
    return await this.prisma.est_contagem_itens.findFirst({
      where: { id: itemId }
    });
  }

  async getEstoqueProduto(codProduto: number, empresa: string = '3'): Promise<ConferirEstoqueResponseDto | null> {
    // Sanitização adicional
    if (!/^\d+$/.test(empresa)) {
      throw new BadRequestException('Empresa inválida');
    }

    // Monta o SQL que será passado DENTRO do OPENQUERY (dialeto Firebird)
    const innerSql = [
      'SELECT',
      '    PRO.pro_codigo,',
      '    MAX(PRO.estoque_disponivel) AS ESTOQUE',
      'FROM lanctos_estoque EST',
      'JOIN PRODUTOS PRO',
      '    ON (EST.pro_codigo = PRO.pro_codigo)',
      '    AND (EST.empresa = PRO.empresa)',
      'JOIN MARCAS MC',
      '    ON (MC.EMPRESA = PRO.EMPRESA)',
      '    AND (MC.MAR_CODIGO = PRO.MAR_CODIGO)',
      `WHERE EST.empresa = '${empresa}'`,
      `    AND PRO.pro_codigo = ${codProduto}`,
      'GROUP BY PRO.pro_codigo'
    ].join('\n');

    // Escapa aspas simples para T-SQL
    const innerEscaped = innerSql.replace(/'/g, "''");

    const outerSql = `
      /* conferir-estoque OPENQUERY */
      SELECT *
      FROM OPENQUERY(CONSULTA, '${innerEscaped}');
    `;

    // Executa via .query para retornar recordset
    const rows = await this.oq.query<ConferirEstoqueResponseDto>(outerSql, {}, { timeout: 30_000 });

    return rows.length > 0 ? rows[0] : null;
  }

  async updateLiberadoContagem(
    contagem_cuid: string,
    contagem: number,
    divergencia: boolean,
    itensParaRevalidar: string[] = []
  ) {
    // 0. Revalidação Seletiva de Itens Falhos
    if (itensParaRevalidar && itensParaRevalidar.length > 0) {
      console.log(`[DEBUG] Revalidando ${itensParaRevalidar.length} itens que falharam anteriormente...`);
      for (const itemId of itensParaRevalidar) {
        try {
          const item = await this.prisma.est_contagem_itens.findUnique({ where: { id: itemId } });
          if (item) {
            const produtoEstoque = await this.getEstoqueProduto(item.cod_produto);
            if (produtoEstoque) {
              // Atualiza o estoque persistido e marca para conferir se divergir (logica simplificada aqui, 
              // pois a validação completa do grupo roda abaixo, o importante é atualizar o estoque)
              await this.prisma.est_contagem_itens.update({
                where: { id: itemId },
                data: { estoque: produtoEstoque.ESTOQUE }
              });
              console.log(`[DEBUG] Item ${itemId} revalidado com estoque ${produtoEstoque.ESTOQUE}`);
            }
          }
        } catch (e) {
          console.error(`[DEBUG] Falha ao revalidar item ${itemId}`, e);
          // Se falhar de novo, infelizmente vai usar o valor antigo.
        }
      }
    }

    // Sempre trava a contagem atual (liberado_contagem = false)
    await this.prisma.est_contagem.updateMany({
      where: {
        contagem_cuid: contagem_cuid,
        contagem: contagem,
      },
      data: { liberado_contagem: false },
    });

    // Se está na contagem 3, não há próxima para liberar
    if (contagem === 3) {
      return await this.prisma.est_contagem.updateMany({
        where: {
          contagem_cuid: contagem_cuid,
          contagem: contagem,
        },
        data: { liberado_contagem: false },
      });
    }

    // Se divergência já for TRUE pelo frontend, segue normal.
    // Mas se for FALSE, precisamos verificar se não há "falsos positivos" (itens pendentes marcados como verdes)
    let temDivergenciaReal = divergencia;

    if (!temDivergenciaReal) {
      // Buscar itens para conferir se a soma bate
      // Busca itens da contagem atual
      // Precisamos dos LOGS também para somar
      // Isso pode ser pesado, mas necessário para segurança.
      const itens = await this.prisma.est_contagem_itens.findMany({
        where: { contagem_cuid: contagem_cuid },
      });

      // Agrupar itens por código de produto
      const itemsByProduct: Record<string, typeof itens> = {};
      for (const item of itens) {
        const key = String(item.cod_produto);
        if (!itemsByProduct[key]) itemsByProduct[key] = [];
        itemsByProduct[key].push(item);
      }

      // Iterar por CÓDIGO DE PRODUTO (Agrupamento)
      for (const codProduto in itemsByProduct) {
        const groupItems = itemsByProduct[codProduto];

        // Se houver apenas 1 item e não tiver aplicação, segue lógica padrão individual
        // Mas para garantir consistência, vamos usar a lógica de soma para tudo.

        // 1. Calcular o Estoque de Referência
        // Como agora o updateItemConferir ATUALIZA o campo estoque com o valor da OpenQuery no momento do salvo,
        // podemos confiar no valor do banco, sem precisar fazer fetch de novo aqui.
        // Isso atende o requisito: "a busca deve ser feita sempre que for clicado em salvar no item no front"
        const estoqueRef = groupItems[0].estoque || 0;

        // 2. Calcular a Soma Total Contada para este Produto (somando logs de todos os itens do grupo)
        let grandTotalContado = 0;

        // Precisamos dos IDs de contagem para filtrar logs (Ajuste anterior: contagemIds)
        const contagemRows = await this.prisma.est_contagem.findMany({
          where: { contagem_cuid: contagem_cuid, contagem: contagem },
          select: { id: true }
        });
        const contagemIds = contagemRows.map(c => c.id);

        if (contagemIds.length > 0) {
          for (const item of groupItems) {
            // Buscar logs para este item
            const logs = await this.prisma.est_contagem_log.findMany({
              where: { identificador_item: item.identificador_item }, // Logs são por item
            });

            // Filtrar logs apenas da contagem atual (Ids encontrados)
            const activeLogs = logs.filter(l => contagemIds.includes(l.contagem_id));

            // Soma simples dos logs deste item
            // FIX: Evita somar logs duplicados caso itemsByProduct tenha mais de 1 item (locações diferentes)
            // mas que apontam para o mesmo identificador_item.
            // Como estamos iterando por GROUP ITEMS, se tivermos 2 itens com mesmo identificador,
            // vamos processar 2 vezes.
            // A solução é iterar por "Identificador Item Único" dentro do grupo de produtos.
            const uniqueIdentifiers = [...new Set(groupItems.map(i => i.identificador_item).filter(id => id !== null))];

            grandTotalContado = 0; // Reinicia para calcular corretamente baseados nos unicos

            for (const idIdentificador of uniqueIdentifiers) {
              const logs = await this.prisma.est_contagem_log.findMany({
                where: { identificador_item: idIdentificador },
              });
              // Filtra logs apenas da contagem atual
              const activeLogs = logs.filter(l => contagemIds.includes(l.contagem_id));
              const partSum = activeLogs.reduce((acc, log) => acc + log.contado, 0);
              grandTotalContado += partSum;
            }

            // Break loop para não repetir soma para cada item do grupo, já calculamos o total do PRODUTO.
            break;
          }

          // 3. Comparar Soma Total x Estoque Total
          if (grandTotalContado !== estoqueRef) {
            temDivergenciaReal = true;

            // ATUALIZAR TODOS OS ITENS DO GRUPO
            const itemIds = groupItems.map(i => i.id);
            await this.prisma.est_contagem_itens.updateMany({
              where: { id: { in: itemIds } },
              data: { conferir: true }
            });
          }
        }
      }
    }

    if (temDivergenciaReal) {
      console.log(`[DEBUG] updateLiberadoContagem: CUID=${contagem_cuid}, Contagem=${contagem} (${typeof contagem}), Divergencia=${divergencia}`);

      // GARANTIA EXTRA DE TIPO
      const contagemNum = Number(contagem);

      // Se divergência, libera a próxima contagem (se existir)
      // Lógica Paranóica: Se for 1 vai pra 2. Se for 2 vai pra 3.
      const contagemParaLiberar = contagemNum === 1 ? 2 : 3;

      console.log(`[DEBUG] Próxima contagem calculada: ${contagemParaLiberar}`);

      // Buscar IDs das contagens que serão liberadas para evitar update desnecessário se não existir
      const contagensAlvo = await this.prisma.est_contagem.findMany({
        where: {
          contagem_cuid: contagem_cuid,
          contagem: contagemParaLiberar
        },
        select: { id: true }
      });

      console.log(`[DEBUG] Contagens alvo encontradas: ${contagensAlvo.length}`);

      let updatedCount = 0;
      if (contagensAlvo.length > 0) {
        const updateResult = await this.prisma.est_contagem.updateMany({
          where: {
            contagem_cuid: contagem_cuid,
            contagem: contagemParaLiberar,
          },
          data: { liberado_contagem: true },
        });
        updatedCount = updateResult.count;
        console.log(`[DEBUG] Update realizado. Linhas afetadas: ${updatedCount}`);
      }

      // Se estamos liberando a próxima contagem, precisamos também marcar os ITENS que deram divergência
      // para aparecerem nela (“conferir: true”).
      // O frontend já devia ter setado via updateItemConferir, mas como garantia extra:
      // (Isso seria pesado fazer aqui sem saber quais itens deram divergência exata. 
      //  Assumimos que o updateItemConferir já cuidou disso).

      // Retorna a contagem liberada para confirmação
      const contagemAtualizada = await this.prisma.est_contagem.findFirst({
        where: {
          contagem_cuid: contagem_cuid,
          contagem: contagemParaLiberar,
        },
      });

      return contagemAtualizada;
    }

    // Se não há divergência, só trava o atual e não libera o próximo
    return await this.prisma.est_contagem.findFirst({
      where: {
        contagem_cuid: contagem_cuid,
        contagem: contagem,
      },
    });
  }

  async getContagensByGrupo(contagem_cuid: string) {
    // Buscar todas as contagens de um grupo específico
    const contagens = await this.prisma.est_contagem.findMany({
      where: {
        contagem_cuid: contagem_cuid
      },
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            codigo: true
          }
        }
      },
      orderBy: {
        contagem: 'asc' // Ordena por tipo: 1, 2, 3
      }
    });

    // Buscar os itens do grupo (compartilhados por todas as contagens)
    const itens = await this.prisma.est_contagem_itens.findMany({
      where: {
        contagem_cuid: contagem_cuid
      },
      orderBy: {
        cod_produto: 'asc'
      }
    });

    // Adicionar os mesmos itens a todas as contagens do grupo
    const contagensComItens = contagens.map(contagem => ({
      ...contagem,
      itens: itens
    }));

    return contagensComItens;
  }

  async getLogsAgregadosPorContagem(contagemId: string) {
    // 1. Buscar a contagem para obter o CUID
    const contagem = await this.prisma.est_contagem.findUnique({
      where: { id: contagemId },
      select: { contagem_cuid: true }
    });

    if (!contagem || !contagem.contagem_cuid) {
      return [];
    }

    // 2. Buscar os itens associados a este CUID
    const itens = await this.prisma.est_contagem_itens.findMany({
      where: { contagem_cuid: contagem.contagem_cuid },
      select: { identificador_item: true }
    });

    // Extrair identificadores únicos
    const identificadores = [...new Set(itens.map(i => i.identificador_item).filter(Boolean))];

    if (identificadores.length === 0) {
      return [];
    }

    // 2. Buscar TODOS os logs que referenciam esses identificadores
    //    Isso traz logs dessa contagem E de outras contagens (irmãs)
    const logs = await this.prisma.est_contagem_log.findMany({
      where: {
        identificador_item: {
          in: identificadores as string[]
        }
      },
      include: {
        item: {
          select: {
            cod_produto: true,
            desc_produto: true,
            localizacao: true
          }
        },
        usuario: {
          select: {
            nome: true
          }
        },
        contagem: {
          select: {
            contagem: true // Importante para saber se é Round 1, 2 ou 3
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    return logs;
  }

  async getAllContagens(params: {
    page?: number;
    pageSize?: number;
    data?: string;
    piso?: string;
  } = {}) {
    const { page = 1, pageSize = 20, data, piso } = params;
    const skip = (page - 1) * pageSize;

    // Construir os filtros dinamicamente
    const whereClause: Prisma.est_contagemWhereInput = {
      status: 0 // Apenas ativos
    };

    if (piso) {
      whereClause.piso = piso;
    }

    if (data) {
      // Filtrar contagens que tenham itens na data específica
      // A tabela est_contagem_itens tem a data.
      // query: Buscar contagens onde EXISTS pelo menos um item com a data.
      whereClause.contagem_cuid = {
        in: await this.findContagemCuidsByDate(data)
      };
    }

    // Buscar total para paginação
    const total = await this.prisma.est_contagem.count({ where: whereClause });
    const last_page = Math.ceil(total / pageSize);

    // Buscar contagens paginadas
    const contagens = await this.prisma.est_contagem.findMany({
      where: whereClause,
      include: {
        usuario: {
          select: {
            id: true,
            nome: true,
            codigo: true
          }
        },
        logs: {
          select: {
            id: true,
            contagem_id: true,
            usuario_id: true,
            item_id: true,
            estoque: true,
            contado: true,
            created_at: true,
            item: {
              select: {
                cod_produto: true,
                desc_produto: true
              }
            }
          },
          orderBy: {
            created_at: 'desc'
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      },
      skip: skip,
      take: pageSize
    });

    // Precisamos buscar os ITENS para exibir a data correta no frontend
    // O frontend quer exibir a data do item, não a de criação.
    // Vamos buscar o primeiro item de cada contagem para pegar a data.
    const contagensComItens = await Promise.all(contagens.map(async (c) => {
      // Otimização: buscar apenas 1 item para pegar a data
      const primeiroItem = await this.prisma.est_contagem_itens.findFirst({
        where: { contagem_cuid: c.contagem_cuid ?? '' },
        select: { data: true }
      });

      // Validar se o GRUPO (CUID) já foi iniciado (tem logs em QUALQUER contagem do grupo)
      // para controlar a exibição do botão de exclusão no front.
      let grupoIniciado = false;
      if (c.contagem_cuid) {
        const checkLogs = await this.prisma.est_contagem_log.findFirst({
          where: {
            contagem: {
              contagem_cuid: c.contagem_cuid
            }
          },
          select: { id: true }
        });
        grupoIniciado = !!checkLogs;
      }

      return {
        ...c,
        grupo_iniciado: grupoIniciado, // Nova propriedade
        itens: primeiroItem ? [{ data: primeiroItem.data }] : [] // Mock items array with just date
      };
    }));

    return {
      data: contagensComItens,
      total,
      page,
      last_page
    };
  }

  // Helper para buscar CUIDs por data de item
  private async findContagemCuidsByDate(dateStr: string): Promise<string[]> {
    // dateStr deve ser YYYY-MM-DD
    // O banco salva DateTime, mas items salvam a data "truncada" ou especifica?
    // No createContagem: data: produto.DATA (yyyy-mm-dd)
    // Prisma armazena DateTime. Precisamos comparar intervalo ou truncado.
    // Assumindo que est_contagem_itens.data armazena meia-noite do dia.

    // Ajuste para garantir comparação correta com timestamp
    const startDate = new Date(dateStr);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(dateStr);
    endDate.setUTCHours(23, 59, 59, 999);

    const items = await this.prisma.est_contagem_itens.findMany({
      where: {
        data: {
          gte: startDate,
          lte: endDate
        }
      },
      select: { contagem_cuid: true },
      distinct: ['contagem_cuid']
    });

    return items.map(i => i.contagem_cuid);
  }

  async deleteContagem(id: string) {
    // 1. Verificar se a contagem alvo existe
    const contagemAlvo = await this.prisma.est_contagem.findUnique({
      where: { id },
      include: { logs: true }
    });

    if (!contagemAlvo) {
      throw new BadRequestException('Contagem não encontrada');
    }

    // 2. Lógica de Exclusão em Grupo (Smart Delete com Trava de Integridade)
    if (contagemAlvo.contagem_cuid) {
      // Buscar TODAS as contagens ativas do grupo
      const grupoContagens = await this.prisma.est_contagem.findMany({
        where: {
          contagem_cuid: contagemAlvo.contagem_cuid,
          status: 0
        },
        include: { logs: true }
      });

      // TRAVA: Verificar se ALGUMA contagem do grupo já foi iniciada (tem logs)
      const algumIniciado = grupoContagens.some(c => c.logs.length > 0);

      if (algumIniciado) {
        // Se qualquer uma do grupo (1, 2 ou 3) tiver logs, BLOQUEIA A EXCLUSÃO DE TODAS.
        // Motivo: "As contagens sempre são conjunto de 3". Não podemos quebrar o conjunto.
        // O usuário solicitou explicitamente essa trava: se iniciado, permite apenas edição, não exclusão.
        throw new BadRequestException('Não é possível excluir. O grupo de contagens já foi iniciado.');
      }

      // Se NENHUMA foi iniciada, exclui TODAS (status = 1)
      const idsParaExcluir = grupoContagens.map(c => c.id);

      if (idsParaExcluir.length > 0) {
        return await this.prisma.est_contagem.updateMany({
          where: { id: { in: idsParaExcluir } },
          data: { status: 1 }
        });
      }

    } else {
      // Fallback: Sem CUID (isolada), verifica apenas ela mesma
      if (contagemAlvo.logs.length > 0) {
        throw new BadRequestException('Não é possível excluir uma contagem já iniciada (possui registros).');
      }

      return await this.prisma.est_contagem.update({
        where: { id },
        data: { status: 1 }
      });
    }

    return { count: 0, message: "Nenhuma contagem excluída" };
  }

  async createLog(createLogData: {
    contagem_id: string;
    usuario_id: string;
    item_id: string;
    estoque: number;
    contado: number;
    identificador_item?: string;
  }) {
    // 1. Tenta encontrar um log existente específico para este USUÁRIO nesta CONTAGEM e ITEM
    const existingLog = await this.prisma.est_contagem_log.findFirst({
      where: {
        contagem_id: createLogData.contagem_id,
        item_id: createLogData.item_id,
        usuario_id: createLogData.usuario_id,
      },
    });

    if (existingLog) {
      // Se já existe, ATUALIZA o valor (substitui)
      const log = await this.prisma.est_contagem_log.update({
        where: { id: existingLog.id },
        data: {
          estoque: createLogData.estoque,
          contado: createLogData.contado,
          created_at: new Date(),
        },
      });
      return log;
    } else {
      // Se não existe, cria um novo registro
      const log = await this.prisma.est_contagem_log.create({
        data: {
          contagem_id: createLogData.contagem_id,
          usuario_id: createLogData.usuario_id,
          item_id: createLogData.item_id,
          estoque: createLogData.estoque,
          contado: createLogData.contado,
          identificador_item: createLogData.identificador_item
        }
      });
      return log;
    }
  }

  async getLogsByContagem(contagemId: string) {
    return await this.prisma.est_contagem_log.findMany({
      where: {
        contagem_id: contagemId
      },
      include: {
        item: {
          select: {
            cod_produto: true,
            desc_produto: true,
            localizacao: true
          }
        },
        usuario: {
          select: {
            nome: true,
            codigo: true
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });
  }

  private sanitizeData(data: any): any {
    if (typeof data === 'string') {
      return data.replace(/\0/g, ''); // Remove bytes nulos
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizeData(item));
    }

    if (data && typeof data === 'object') {
      return Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, this.sanitizeData(value)])
      );
    }

    return data;
  }

  async updateContagem(id: string, data: Prisma.est_contagemUpdateInput) {
    const sanitizedData = this.sanitizeData(data);
    return this.prisma.est_contagem.update({
      where: { id },
      data: sanitizedData,
    });
  }

  async createContagemItem(data: Prisma.est_contagem_itensCreateInput) {
    const sanitizedData = this.sanitizeData(data);
    return this.prisma.est_contagem_itens.create({ data: sanitizedData });
  }

  async updateContagemItem(id: string, data: Prisma.est_contagem_itensUpdateInput) {
    const sanitizedData = this.sanitizeData(data);
    return this.prisma.est_contagem_itens.update({
      where: { id },
      data: sanitizedData,
    });
  }
}
