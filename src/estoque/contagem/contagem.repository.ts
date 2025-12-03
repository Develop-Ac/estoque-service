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
  ) {}

  async fetchSaidas(params: {
    data_inicial: string; // YYYY-MM-DD
    data_final: string;   // YYYY-MM-DD
    empresa: string;      // '3' por default
  }): Promise<EstoqueSaidaRow[]> {
    const { data_inicial, data_final, empresa } = params;

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
      let txt: string | null;
      try {
        txt = this.toUtf8Text((row as any).APLICACOES);
      } catch (e) {
        console.error('Falha ao converter APLICACOES na linha', i, row?.COD_PRODUTO, e);
        txt = null;
      }
      return { ...row, APLICACOES: txt };
    });

    // Duplica os itens conforme solicitado
    const result: EstoqueSaidaRow[] = [];
    for (const item of sanitizedRows) {
      result.push(item);
      if (item.APLICACOES != null && item.APLICACOES.trim() !== '') {
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
          LOCALIZACAO: asCleanNullableText(p.LOCALIZACAO),
          UNIDADE: asCleanNullableText(p.UNIDADE),
          // APLICACOES costuma vir com bytes binários; limpamos NUL e convertemos:
          APLICACOES: asCleanNullableText(p.APLICACOES),
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

            const item = await tx.est_contagem_itens.create({
            data: {
              identificador_item: `${produto.COD_PRODUTO}-${dataStr}`, // ID único composto
              contagem_cuid: grupoContagem,
              data: produto.DATA, // salva apenas yyyy-mm-dd
              cod_produto: produto.COD_PRODUTO,
              desc_produto: produto.DESC_PRODUTO ?? '',       // strings limpas (sem 0x00) ou null
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
    const usuario = await this.prisma.sis_usuarios.findUnique({
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

    console.log('updateItemConferir called with:', { identificador_item, conferir });
 
    const item = await this.prisma.est_contagem_log.findFirst({
      where: { identificador_item: identificador_item }
    });
    
    const conferirValue = item?.estoque === item?.contado

    console.log('updateItemConferir:', { itemId });

    // Atualiza somente o campo 'conferir' do item de contagem
    const updated = await this.prisma.est_contagem_itens.update({
      where: { id: itemId },
      data: { conferir: !conferirValue },
    });

    return updated;
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
    divergencia: boolean
  ) { 
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

    if (divergencia) {
      // Se divergência, libera a próxima contagem (se existir)
      const contagemParaLiberar = contagem === 1 ? 2 : 3;
      const updated = await this.prisma.est_contagem.updateMany({
        where: {
          contagem_cuid: contagem_cuid,
          contagem: contagemParaLiberar,
        },
        data: { liberado_contagem: true },
      });

      if (updated.count === 0) {
        throw new BadRequestException(
          `Nenhuma contagem encontrada com contagem_cuid "${contagem_cuid}" e tipo ${contagemParaLiberar}`
        );
      }

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

  async getAllContagens() {
    // Buscar todas as contagens com informações do usuário e logs
    const contagens = await this.prisma.est_contagem.findMany({
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
      }
    });

    return contagens;
  }

  async createLog(createLogData: {
    contagem_id: string;
    usuario_id: string;
    item_id: string;
    estoque: number;
    contado: number;
    identificador_item?: string;
  }) {
    // Primeiro, verifica se já existe um log com o mesmo contagem_id e item_id
    const existingLog = await this.prisma.est_contagem_log.findMany({
      where: {
        identificador_item: createLogData.identificador_item,
      }
    });

    console.log('existingLog:', existingLog);

    if (Array.isArray(existingLog) && existingLog.length === 1) {
      const current = existingLog[0];

      const updatedLog = await this.prisma.est_contagem_log.update({
        where: {
          id: current.id,
        },
        data: {
          usuario_id: createLogData.usuario_id,
          estoque: createLogData.estoque,
          contado: current.contado + createLogData.contado, // só usa o existente
          created_at: new Date(),
        },
      });

      const log = await this.prisma.est_contagem_log.create({
        data: {
          contagem_id: createLogData.contagem_id,
          usuario_id: createLogData.usuario_id,
          item_id: createLogData.item_id,
          estoque: createLogData.estoque,
          contado: current.contado + createLogData.contado, // mesma lógica, se for isso mesmo
          identificador_item: createLogData.identificador_item,
        },
      });

      return log;
    }else {
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
    // Aplicar sanitização antes da criação
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
