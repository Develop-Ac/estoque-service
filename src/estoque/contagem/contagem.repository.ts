import { Injectable, BadRequestException } from '@nestjs/common';
import { OpenQueryService } from '../../shared/database/openquery/openquery.service';
import { ErpApiService } from '../../shared/erp-api/erp-api.service';
import { EstoqueSaidaRow } from './contagem.types';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContagemDto } from './dto/create-contagem.dto';
import { ConferirEstoqueResponseDto } from './dto/conferir-estoque-response.dto';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { consolidarProdutoDia, ConsolidadoProdutoDia, Rodada } from './consolidacao-produto';

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
  // BOX (ex: BOX 03, BOX 3, BOX BEBEDOR, BOX 1 CX 4, BOX2A02, BOX3B01)
  // Aceita digitos (com sub-locação opcional tipo A02, B01) OU a palavra especifica BEBEDOR
  const boxMatch = upperApp.match(/\bBOX\s*(?:BEBEDOR|\d+(?:[A-Z]\d+)?(?:\s+CX\s+\d+)?)\b/i);
  if (boxMatch) {
    return boxMatch[0];
  }

  // BOQUETA
  if (upperApp.includes('BOQUETA')) {
    return 'A-BOQUETA';
  }

  // CAIXA ESCADA / CX ESCADA
  if (upperApp.match(/\b(?:CX|CAIXA)\s*ESCADA\b/)) {
    return 'A-CX ESCADA';
  }



  // 3. Regra do Padrão: 1-2 Letras + 2-4 Números + Letra + 1-2 Números
  // Ex: A1204E02, C16D1 e Vitrine Móvel VM202A01 / VM0202A01 (prefixo de 2 letras).
  // Regex: \b[A-Z]{1,2}\d{2,4}[A-Z]\d{1,2}\b (Case insensitive)
  const codeRegex = /\b[A-Z]{1,2}\d{2,4}[A-Z]\d{1,2}\b/gi;
  const matches = text.match(codeRegex);

  if (matches && matches.length > 0) {
    // Junta todos os códigos encontrados com espaço
    return matches.join(' ');
  }

  // Se não caiu em nenhuma regra, considera lixo e retorna null
  return null;
}

// Versão "N locações" de formatAndValidateLocation: em vez de juntar os códigos
// encontrados numa única string, devolve a LISTA de locações reconhecidas.
// Espelha exatamente as mesmas regras (inclusive o BOX sem prefixo "A-").
// - Regras especiais (BOX, BOQUETA, CX ESCADA) => 1 locação.
// - Padrão de código (Letra+Núm+Letra+Núm) => N locações (uma por código).
// - Nada reconhecido => lista vazia (deixa o chamador decidir o fallback).
function extractLocations(text: string | null): string[] {
  if (!text) return [];

  const upperApp = text.toUpperCase();

  // BOX (ex: BOX 03, BOX 3, BOX BEBEDOR, BOX 1 CX 4, BOX2A02, BOX3B01)
  const boxMatch = upperApp.match(/\bBOX\s*(?:BEBEDOR|\d+(?:[A-Z]\d+)?(?:\s+CX\s+\d+)?)\b/i);
  if (boxMatch) {
    return [boxMatch[0]];
  }

  // BOQUETA
  if (upperApp.includes('BOQUETA')) {
    return ['A-BOQUETA'];
  }

  // CAIXA ESCADA / CX ESCADA
  if (upperApp.match(/\b(?:CX|CAIXA)\s*ESCADA\b/)) {
    return ['A-CX ESCADA'];
  }

  // Padrão de código: 1-2 Letras + 2-4 Números + Letra + 1-2 Números (ex.: A1204E02,
  // e Vitrine Móvel VM202A01 / VM0202A01, cujo prefixo tem 2 letras).
  // Um mesmo campo pode conter VÁRIOS códigos -> cada um vira uma locação.
  const codeRegex = /\b[A-Z]{1,2}\d{2,4}[A-Z]\d{1,2}\b/gi;
  const matches = text.match(codeRegex);
  if (matches && matches.length > 0) {
    return matches;
  }

  return [];
}

// Classificação de piso — mesmas regras do filtro local da tela de contagem, agora
// aplicáveis ANTES da busca da avulsa (o valor de `piso` é o value do select do front).
function locacaoPertenceAoPiso(locacaoRaw: string | null | undefined, piso: string): boolean {
  const loc = (locacaoRaw ?? '').toUpperCase().trim();
  switch (piso) {
    case 'PISO_A':
      return loc.startsWith('A') || loc.startsWith('BOX');
    case 'PISO_B':
      return loc.startsWith('B') && !loc.startsWith('BOX');
    case 'PISO_C':
      return loc.startsWith('C');
    case 'BOX':
      return loc.startsWith('BOX');
    case 'A-BOQUETA':
      return loc.startsWith('A-BOQUETA');
    case 'A-CX ESCADA':
      return loc.startsWith('A-CX ESCADA');
    case 'VITRINE':
      // Inclui Vitrine Móvel (VM): é o mesmo colaborador que conta.
      return loc === 'VITRINE' || /^V\d/.test(loc) || loc.startsWith('VM');
    case 'VM':
      return loc.startsWith('VM');
    case 'VENDA CASADA':
      return loc === 'VENDA CASADA';
    default:
      return true;
  }
}

// Anatomia da locação: Piso (1-2 letras) + Rua/Prateleira (1-2 dígitos) +
// Prédio/Coluna (2 dígitos) + Andar (letra) + Apartamento (1-2 dígitos).
// Prateleira de 1 a 9 NÃO leva zero à esquerda: A903B02 é prateleira 9 / prédio 03,
// e A1403A03 é prateleira 14 / prédio 03. Por isso o corte é "o bloco de dígitos
// menos os 2 últimos (o prédio)" — nunca "os 2 primeiros dígitos".
function extrairPrateleira(locacaoRaw: string | null | undefined): number | null {
  const m = (locacaoRaw ?? '').toUpperCase().trim().match(/^[A-Z]{1,2}(\d{2,4})[A-Z]\d/);
  if (!m) return null;
  const bloco = m[1];
  // Bloco de 2 dígitos é a forma curta sem prédio (ex.: C16D1 -> prateleira 16).
  const prateleira = bloco.length <= 2 ? bloco : bloco.slice(0, bloco.length - 2);
  const n = parseInt(prateleira, 10);
  return Number.isFinite(n) ? n : null;
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
    private readonly erpApi: ErpApiService,
    private readonly prisma: PrismaService
  ) { }

  async fetchSaidas(params: {
    data_inicial: string; // YYYY-MM-DD
    data_final: string;   // YYYY-MM-DD
    empresa: string;      // '3' por default
    tipo?: number;        // 1=Diária, 2=Avulsa
  }): Promise<EstoqueSaidaRow[]> {
    return this.erpApi.comFallback(
      () => this.fetchSaidasViaApi(params),
      () => this.fetchSaidasViaOpenQuery(params),
    );
  }

  /**
   * Saídas pela erp-firebird-api. A definição de saída (tudo que não tem origem
   * NFE/CNE) vive no catálogo de lá — a mesma regra, num lugar só, para quem
   * mais precisar dela.
   */
  private async fetchSaidasViaApi(params: {
    data_inicial: string;
    data_final: string;
    empresa: string;
  }): Promise<EstoqueSaidaRow[]> {
    const { data_inicial, data_final, empresa } = params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_inicial) || !/^\d{4}-\d{2}-\d{2}$/.test(data_final)) {
      throw new BadRequestException('Datas devem ser YYYY-MM-DD');
    }
    if (!/^\d+$/.test(empresa)) {
      throw new BadRequestException('Empresa inválida');
    }

    const linhas = await this.erpApi.saidasPorPeriodo(data_inicial, data_final, Number(empresa));
    return this.explodeByLocation(linhas.map((l) => this.paraLinhaDeSaida(l)));
  }

  /**
   * Nomes do catálogo -> nomes que a contagem usa. PRO_CODIGO/PRO_DESCRICAO são
   * como a coluna se chama no ERP; COD_PRODUTO/DESC_PRODUTO é o contrato que a
   * tela e o banco local já esperam.
   */
  private paraLinhaDeSaida(l: any): EstoqueSaidaRow {
    return {
      ...l,
      COD_PRODUTO: l.PRO_CODIGO,
      DESC_PRODUTO: l.PRO_DESCRICAO,
    } as EstoqueSaidaRow;
  }

  private async fetchSaidasViaOpenQuery(params: {
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
      // LEFT, e não INNER: marca é opcional no cadastro. Com INNER, produto sem
      // MAR_CODIGO sumia da contagem sem aviso — 18.513 produtos da empresa 3
      // estão nessa situação, e 101 deles tiveram saída só no mês de julho/2026.
      // Numa conferência de estoque, a omissão silenciosa é pior que o dado
      // faltando: o contador conclui que não saiu nada.
      'LEFT JOIN MARCAS MC',
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

    // Explode cada produto em N linhas — uma por localização DISTINTA.
    // Tanto LOCALIZACAO (campo mestre) quanto APLICACOES (campo secundário) podem,
    // cada um, conter VÁRIAS locações. Antes a lógica gerava no máximo 2 linhas por
    // produto (1 p/ LOCALIZACAO + 1 p/ APLICACOES); agora geramos N (uma por locação,
    // sem duplicatas) para suportar produtos com mais de duas localizações.
    const result: EstoqueSaidaRow[] = [];

    (rows ?? []).forEach((row, i) => {
      const rawLoc = this.toUtf8Text((row as any).LOCALIZACAO);
      const rawApp = this.toUtf8Text((row as any).APLICACOES);

      // Locações do campo mestre. Se nenhuma regra reconhecer, mantemos o valor
      // original do ERP como locação única (confiança no ERP).
      let locsPrincipais: string[];
      try {
        const extraidas = extractLocations(rawLoc);
        locsPrincipais = extraidas.length > 0 ? extraidas : (rawLoc ? [rawLoc] : []);
      } catch (e) {
        console.error('Falha ao converter LOCALIZACAO na linha', i, row?.COD_PRODUTO, e);
        locsPrincipais = rawLoc ? [rawLoc] : [];
      }

      // Locações do campo APLICACOES: só entram se passarem nas regras
      // (ex.: "HB20" é aplicação de veículo, não locação -> ignorado).
      let locsAplicacoes: string[];
      try {
        locsAplicacoes = extractLocations(rawApp);
      } catch (e) {
        console.error('Falha ao converter APLICACOES na linha', i, row?.COD_PRODUTO, e);
        locsAplicacoes = [];
      }

      // Une (mestre primeiro), removendo duplicatas (case-insensitive).
      const seen = new Set<string>();
      const locacoes: string[] = [];
      for (const loc of [...locsPrincipais, ...locsAplicacoes]) {
        const valor = loc?.trim();
        if (!valor) continue;
        const key = valor.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        locacoes.push(valor);
      }

      // Emite uma linha por locação. Se nada foi reconhecido, emite o item uma vez
      // (com a localização original) para não sumir com o produto da contagem.
      if (locacoes.length === 0) {
        result.push({ ...row, LOCALIZACAO: rawLoc, APLICACOES: null });
        return;
      }

      for (const loc of locacoes) {
        result.push({ ...row, LOCALIZACAO: loc, APLICACOES: null });
      }
    });

    return result;
  }

  /**
   * Explode cada linha de produto em N linhas — uma por localização distinta —
   * usando exatamente as mesmas regras de multilocação da contagem rotativa
   * (campo mestre LOCALIZACAO + campo secundário APLICACOES).
   */
  private explodeByLocation(rows: EstoqueSaidaRow[] | undefined): EstoqueSaidaRow[] {
    const result: EstoqueSaidaRow[] = [];

    (rows ?? []).forEach((row, i) => {
      const rawLoc = this.toUtf8Text((row as any).LOCALIZACAO);
      const rawApp = this.toUtf8Text((row as any).APLICACOES);

      let locsPrincipais: string[];
      try {
        const extraidas = extractLocations(rawLoc);
        locsPrincipais = extraidas.length > 0 ? extraidas : (rawLoc ? [rawLoc] : []);
      } catch (e) {
        console.error('Falha ao converter LOCALIZACAO na linha', i, row?.COD_PRODUTO, e);
        locsPrincipais = rawLoc ? [rawLoc] : [];
      }

      let locsAplicacoes: string[];
      try {
        locsAplicacoes = extractLocations(rawApp);
      } catch (e) {
        console.error('Falha ao converter APLICACOES na linha', i, row?.COD_PRODUTO, e);
        locsAplicacoes = [];
      }

      const seen = new Set<string>();
      const locacoes: string[] = [];
      for (const loc of [...locsPrincipais, ...locsAplicacoes]) {
        const valor = loc?.trim();
        if (!valor) continue;
        const key = valor.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        locacoes.push(valor);
      }

      if (locacoes.length === 0) {
        result.push({ ...row, LOCALIZACAO: rawLoc, APLICACOES: null });
        return;
      }

      for (const loc of locacoes) {
        result.push({ ...row, LOCALIZACAO: loc, APLICACOES: null });
      }
    });

    return result;
  }

  /**
   * CONTAGEM AVULSA: busca produtos do CADASTRO (não da movimentação) aplicando
   * filtros escolhidos pelo usuário (grupo/subgrupo/marca/descrição/código).
   * Diferente da rotativa, não há filtro por lanctos_estoque; QTDE_SAIDA = 0 e a
   * DATA do item é a data atual (CURRENT_DATE). Exige ao menos um filtro para não
   * trazer o catálogo inteiro.
   */
  async fetchProdutosPorFiltro(params: {
    empresa: string;       // '3' por default
    cod_produto?: number;
    cod_produtos?: number[]; // vários códigos de uma vez (chips na tela)
    marca?: number;        // MAR_CODIGO
    descricao?: string;    // LIKE em PRO.pro_descricao
    grupo?: number;        // GRP_CODIGO
    subgrupo?: number;     // SUBGRP_CODIGO
    somente_com_saldo?: boolean; // (disponivel + reservado) > 0
    piso?: string;         // PISO_A, PISO_B, BOX, VITRINE... (recorte pós-explode)
    prateleira?: number;   // dois dígitos após a letra do piso (recorte pós-explode)
  }): Promise<EstoqueSaidaRow[]> {
    const rows = await this.erpApi.comFallback(
      () => this.fetchProdutosPorFiltroViaApi(params),
      () => this.fetchProdutosPorFiltroViaOpenQuery(params),
    );

    // Piso e prateleira são atributos da LOCAÇÃO, não do produto: só dá para recortar
    // depois do explode (uma linha por locação). Por isso o filtro fica aqui, sobre as
    // linhas prontas, e vale para os dois caminhos (API e OPENQUERY).
    const piso = (params.piso ?? '').trim();
    let filtradas = rows;
    if (piso) {
      filtradas = filtradas.filter((r) => locacaoPertenceAoPiso((r as any).LOCALIZACAO, piso));
    }
    if (params.prateleira != null && Number.isFinite(params.prateleira)) {
      filtradas = filtradas.filter(
        (r) => extrairPrateleira((r as any).LOCALIZACAO) === params.prateleira,
      );
    }
    return filtradas;
  }

  private async fetchProdutosPorFiltroViaApi(params: {
    empresa: string;
    cod_produto?: number;
    cod_produtos?: number[];
    marca?: number;
    descricao?: string;
    grupo?: number;
    subgrupo?: number;
    somente_com_saldo?: boolean;
    piso?: string;
  }): Promise<EstoqueSaidaRow[]> {
    const { empresa } = params;
    if (!/^\d+$/.test(empresa)) throw new BadRequestException('Empresa inválida');

    const toInt = (v: any): number | undefined => {
      if (v === undefined || v === null || String(v).trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : undefined;
    };
    const cod_produto = toInt(params.cod_produto);
    // União do código único com a lista de chips — a tela pode mandar os dois.
    const codigos = [...new Set(
      [cod_produto, ...(params.cod_produtos ?? []).map(toInt)]
        .filter((c): c is number => c != null),
    )];
    const marca = toInt(params.marca);
    const grupo = toInt(params.grupo);
    const subgrupo = toInt(params.subgrupo);
    const descricao = (params.descricao ?? '').trim().toUpperCase();
    // Piso conta como filtro: o recorte acontece pós-explode (no wrapper), mas a busca
    // "só por piso" é legítima — traz o catálogo com saldo e filtra as locações.
    const temPiso = (params.piso ?? '').trim().length > 0;

    if (codigos.length === 0 && marca == null && grupo == null && subgrupo == null && !descricao && !temPiso) {
      throw new BadRequestException(
        'Informe ao menos um filtro (grupo, subgrupo, marca, descrição, código ou piso) para a contagem avulsa.'
      );
    }

    // Vários códigos: uma consulta por código, em paralelo — o agrupador do outro lado
    // junta as chamadas que chegam na mesma janela num único SELECT com IN.
    const linhas = codigos.length > 0
      ? (await Promise.all(
          codigos.map((c) => this.erpApi.produtosPorFiltro({
            empresa, cod_produto: c, marca, grupo, subgrupo, descricao: descricao || undefined,
          })),
        )).flat()
      : await this.erpApi.produtosPorFiltro({
          empresa, marca, grupo, subgrupo, descricao: descricao || undefined,
        });

    const hoje = new Date();
    // Saldo é soma de duas colunas: o catálogo filtra coluna a coluna, então
    // este recorte fica aqui, sobre o conjunto que os outros filtros já reduziram.
    const filtradas = params.somente_com_saldo
      ? linhas.filter((l) => (Number(l.ESTOQUE_DISPONIVEL) || 0) + (Number(l.ESTOQUE_RESERVADO) || 0) > 0)
      : linhas;

    return this.explodeByLocation(
      filtradas.map((l) => ({
        ...l,
        DATA: hoje,
        COD_PRODUTO: l.PRO_CODIGO,
        DESC_PRODUTO: l.PRO_DESCRICAO,
        QTDE_SAIDA: 0,
        ESTOQUE: l.ESTOQUE_DISPONIVEL,
        RESERVA: l.ESTOQUE_RESERVADO,
      })) as EstoqueSaidaRow[],
    );
  }

  private async fetchProdutosPorFiltroViaOpenQuery(params: {
    empresa: string;       // '3' por default
    cod_produto?: number;
    cod_produtos?: number[];
    marca?: number;        // MAR_CODIGO
    descricao?: string;    // LIKE em PRO.pro_descricao
    grupo?: number;        // GRP_CODIGO
    subgrupo?: number;     // SUBGRP_CODIGO
    somente_com_saldo?: boolean; // (disponivel + reservado) > 0
    piso?: string;
  }): Promise<EstoqueSaidaRow[]> {
    const { empresa } = params;

    if (!/^\d+$/.test(empresa)) {
      throw new BadRequestException('Empresa inválida');
    }

    // Normaliza/valida filtros numéricos. Trata ''/null/undefined/NaN como ausente
    // (evita filtrar por 0 quando Number('') === 0).
    const toInt = (v: any): number | undefined => {
      if (v === undefined || v === null || String(v).trim() === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : undefined;
    };
    const codProduto = toInt(params.cod_produto);
    // União do código único com a lista de chips; só inteiros entram no literal.
    const codigos = [...new Set(
      [codProduto, ...(params.cod_produtos ?? []).map(toInt)]
        .filter((c): c is number => c != null),
    )];
    const marca = toInt(params.marca);
    const grupo = toInt(params.grupo);
    const subgrupo = toInt(params.subgrupo);

    // Descrição: remove aspas simples (evita quebra do literal Firebird) e normaliza.
    const descricao = (params.descricao ?? '').replace(/'/g, '').trim().toUpperCase();

    const temFiltro =
      codigos.length > 0 || marca != null || grupo != null || subgrupo != null ||
      descricao.length > 0 || (params.piso ?? '').trim().length > 0;
    if (!temFiltro) {
      throw new BadRequestException(
        'Informe ao menos um filtro (grupo, subgrupo, marca, descrição, código ou piso) para a contagem avulsa.'
      );
    }

    const where: string[] = [`WHERE PRO.empresa = '${empresa}'`];
    if (codigos.length === 1) where.push(`AND PRO.pro_codigo = ${codigos[0]}`);
    else if (codigos.length > 1) where.push(`AND PRO.pro_codigo IN (${codigos.join(', ')})`);
    if (marca != null) where.push(`AND PRO.mar_codigo = ${marca}`);
    if (grupo != null) where.push(`AND SG.grp_codigo = ${grupo}`);
    if (subgrupo != null) where.push(`AND PRO.subgrp_codigo = ${subgrupo}`);
    if (descricao.length > 0) where.push(`AND UPPER(PRO.pro_descricao) LIKE '%${descricao}%'`);
    if (params.somente_com_saldo) {
      where.push(`AND (COALESCE(PRO.estoque_disponivel,0) + COALESCE(PRO.estoque_reservado,0)) > 0`);
    }

    const innerSql = [
      'SELECT',
      '    CURRENT_DATE AS DATA,',
      '    PRO.pro_codigo as COD_PRODUTO,',
      '    PRO.pro_descricao AS DESC_PRODUTO,',
      '    MC.mar_descricao,',
      '    PRO.ref_fabricante,',
      '    PRO.ref_FORNECEDOR,',
      '    PRO.localizacao AS LOCALIZACAO,',
      '    PRO.unidade,',
      '    PRO.aplicacoes,',
      '    PRO.codigo_barras,',
      '    0 AS QTDE_SAIDA,',
      '    PRO.estoque_disponivel AS ESTOQUE,',
      '    PRO.estoque_reservado as RESERVA',
      'FROM PRODUTOS PRO',
      // Mesma razão do LEFT na rotativa: com INNER, produto sem marca não
      // aparece na busca da contagem avulsa. São 2.359 produtos com saldo
      // diferente de zero e sem MAR_CODIGO na empresa 3.
      'LEFT JOIN MARCAS MC',
      '    ON (MC.EMPRESA = PRO.EMPRESA)',
      '    AND (MC.MAR_CODIGO = PRO.MAR_CODIGO)',
      'LEFT JOIN PRODUTOS_SUBGRUPOS SG',
      '    ON (SG.EMPRESA = PRO.EMPRESA)',
      '    AND (SG.SUBGRP_CODIGO = PRO.SUBGRP_CODIGO)',
      ...where,
      'ORDER BY PRO.localizacao',
    ].join('\n');

    const innerEscaped = innerSql.replace(/'/g, "''");
    const outerSql = `
      /* contagem-avulsa produtos OPENQUERY */
      SELECT *
      FROM OPENQUERY(CONSULTA, '${innerEscaped}');
    `;

    const rows = await this.oq.query<EstoqueSaidaRow>(outerSql, {}, { timeout: 300_000 });
    return this.explodeByLocation(rows);
  }

  /**
   * Lista de grupos de produto (PRODUTOS_GRUPOS) para popular o filtro da avulsa.
   *
   * As três listas de apoio (grupos, subgrupos, marcas) mudam raramente e são
   * pedidas toda vez que a tela de filtro abre. Pela API elas têm cache de 5
   * minutos do outro lado, compartilhado entre todos os serviços — três idas ao
   * ERP por abertura de tela viram nenhuma na maior parte das vezes.
   */
  async fetchGrupos(empresa: string): Promise<Array<{ GRP_CODIGO: number; GRP_DESCRICAO: string }>> {
    if (!/^\d+$/.test(empresa)) throw new BadRequestException('Empresa inválida');
    return this.erpApi.comFallback(
      async () =>
        (await this.erpApi.grupos(Number(empresa))).map((r) => ({
          GRP_CODIGO: Number(r.GRP_CODIGO),
          GRP_DESCRICAO: this.toUtf8Text(r.GRP_DESCRICAO) ?? '',
        })),
      () => this.fetchGruposViaOpenQuery(empresa),
    );
  }

  private async fetchGruposViaOpenQuery(empresa: string): Promise<Array<{ GRP_CODIGO: number; GRP_DESCRICAO: string }>> {
    const innerSql = [
      'SELECT GR.grp_codigo AS GRP_CODIGO, GR.grp_descricao AS GRP_DESCRICAO',
      'FROM PRODUTOS_GRUPOS GR',
      `WHERE GR.empresa = '${empresa}'`,
      'ORDER BY GR.grp_descricao',
    ].join('\n');
    const innerEscaped = innerSql.replace(/'/g, "''");
    const rows = await this.oq.query<{ GRP_CODIGO: number; GRP_DESCRICAO: string }>(
      `SELECT * FROM OPENQUERY(CONSULTA, '${innerEscaped}');`, {}, { timeout: 120_000 }
    );
    return (rows ?? []).map((r) => ({
      GRP_CODIGO: Number((r as any).GRP_CODIGO),
      GRP_DESCRICAO: this.toUtf8Text((r as any).GRP_DESCRICAO) ?? '',
    }));
  }

  /** Lista de subgrupos (PRODUTOS_SUBGRUPOS), opcionalmente filtrada por grupo. */
  async fetchSubgrupos(empresa: string, grupo?: number): Promise<Array<{ SUBGRP_CODIGO: number; SUBGRP_DESCRICAO: string; GRP_CODIGO: number }>> {
    if (!/^\d+$/.test(empresa)) throw new BadRequestException('Empresa inválida');
    const grp = grupo != null && Number.isFinite(Number(grupo)) ? Math.trunc(Number(grupo)) : undefined;
    return this.erpApi.comFallback(
      async () =>
        (await this.erpApi.subgrupos(Number(empresa), grp)).map((r) => ({
          SUBGRP_CODIGO: Number(r.SUBGRP_CODIGO),
          SUBGRP_DESCRICAO: this.toUtf8Text(r.SUBGRP_DESCRICAO) ?? '',
          GRP_CODIGO: Number(r.GRP_CODIGO),
        })),
      () => this.fetchSubgruposViaOpenQuery(empresa, grp),
    );
  }

  private async fetchSubgruposViaOpenQuery(empresa: string, grp?: number): Promise<Array<{ SUBGRP_CODIGO: number; SUBGRP_DESCRICAO: string; GRP_CODIGO: number }>> {
    const innerSql = [
      'SELECT SG.subgrp_codigo AS SUBGRP_CODIGO, SG.subgrp_descricao AS SUBGRP_DESCRICAO, SG.grp_codigo AS GRP_CODIGO',
      'FROM PRODUTOS_SUBGRUPOS SG',
      `WHERE SG.empresa = '${empresa}'`,
      ...(grp != null ? [`AND SG.grp_codigo = ${grp}`] : []),
      'ORDER BY SG.subgrp_descricao',
    ].join('\n');
    const innerEscaped = innerSql.replace(/'/g, "''");
    const rows = await this.oq.query<{ SUBGRP_CODIGO: number; SUBGRP_DESCRICAO: string; GRP_CODIGO: number }>(
      `SELECT * FROM OPENQUERY(CONSULTA, '${innerEscaped}');`, {}, { timeout: 120_000 }
    );
    return (rows ?? []).map((r) => ({
      SUBGRP_CODIGO: Number((r as any).SUBGRP_CODIGO),
      SUBGRP_DESCRICAO: this.toUtf8Text((r as any).SUBGRP_DESCRICAO) ?? '',
      GRP_CODIGO: Number((r as any).GRP_CODIGO),
    }));
  }

  // Cache da varredura de locações (para o filtro-filho de prateleiras): a lista de
  // locações do catálogo muda devagar e a varredura é uma ida cara ao Firebird.
  private locacoesCatalogoCache: { empresa: string; expiraEm: number; locacoes: string[] } | null = null;

  /**
   * Prateleiras existentes num piso — o filtro-filho da avulsa: escolhido o piso, só as
   * prateleiras dele são oferecidas. Prateleira são os dois dígitos após a letra da
   * locação (A1204E02 -> 12), então a lista sai de uma varredura só das colunas de
   * locação dos produtos com saldo, explodida pelas mesmas regras da contagem.
   */
  async fetchPrateleirasPorPiso(empresa: string, piso: string): Promise<number[]> {
    if (!/^\d+$/.test(empresa)) throw new BadRequestException('Empresa inválida');
    if (!piso?.trim()) throw new BadRequestException('Informe o piso');

    const agora = Date.now();
    let locacoes: string[];

    if (
      this.locacoesCatalogoCache &&
      this.locacoesCatalogoCache.empresa === empresa &&
      this.locacoesCatalogoCache.expiraEm > agora
    ) {
      locacoes = this.locacoesCatalogoCache.locacoes;
    } else {
      const innerSql = [
        'SELECT PRO.localizacao, PRO.aplicacoes',
        'FROM PRODUTOS PRO',
        `WHERE PRO.empresa = '${empresa}'`,
        'AND (COALESCE(PRO.estoque_disponivel,0) + COALESCE(PRO.estoque_reservado,0)) > 0',
      ].join('\n');
      const innerEscaped = innerSql.replace(/'/g, "''");
      const rows = await this.oq.query<{ LOCALIZACAO: any; APLICACOES: any }>(
        `/* prateleiras-por-piso OPENQUERY */ SELECT * FROM OPENQUERY(CONSULTA, '${innerEscaped}');`,
        {},
        { timeout: 120_000 },
      );

      const set = new Set<string>();
      for (const row of rows ?? []) {
        const rawLoc = this.toUtf8Text((row as any).LOCALIZACAO);
        const rawApp = this.toUtf8Text((row as any).APLICACOES);
        const principais = extractLocations(rawLoc);
        for (const l of principais.length ? principais : (rawLoc ? [rawLoc] : [])) set.add(l);
        for (const l of extractLocations(rawApp)) set.add(l);
      }
      locacoes = [...set];
      this.locacoesCatalogoCache = { empresa, expiraEm: agora + 5 * 60_000, locacoes };
    }

    const prateleiras = new Set<number>();
    for (const loc of locacoes) {
      if (!locacaoPertenceAoPiso(loc, piso)) continue;
      const p = extrairPrateleira(loc);
      if (p != null) prateleiras.add(p);
    }
    return [...prateleiras].sort((a, b) => a - b);
  }

  /** Lista de marcas (MARCAS) para popular o filtro da avulsa. */
  async fetchMarcas(empresa: string): Promise<Array<{ MAR_CODIGO: number; MAR_DESCRICAO: string }>> {
    if (!/^\d+$/.test(empresa)) throw new BadRequestException('Empresa inválida');
    return this.erpApi.comFallback(
      async () =>
        (await this.erpApi.marcas(Number(empresa))).map((r) => ({
          MAR_CODIGO: Number(r.MAR_CODIGO),
          MAR_DESCRICAO: this.toUtf8Text(r.MAR_DESCRICAO) ?? '',
        })),
      () => this.fetchMarcasViaOpenQuery(empresa),
    );
  }

  private async fetchMarcasViaOpenQuery(empresa: string): Promise<Array<{ MAR_CODIGO: number; MAR_DESCRICAO: string }>> {
    const innerSql = [
      'SELECT MC.mar_codigo AS MAR_CODIGO, MC.mar_descricao AS MAR_DESCRICAO',
      'FROM MARCAS MC',
      `WHERE MC.empresa = '${empresa}'`,
      'ORDER BY MC.mar_descricao',
    ].join('\n');
    const innerEscaped = innerSql.replace(/'/g, "''");
    const rows = await this.oq.query<{ MAR_CODIGO: number; MAR_DESCRICAO: string }>(
      `SELECT * FROM OPENQUERY(CONSULTA, '${innerEscaped}');`, {}, { timeout: 120_000 }
    );
    return (rows ?? []).map((r) => ({
      MAR_CODIGO: Number((r as any).MAR_CODIGO),
      MAR_DESCRICAO: this.toUtf8Text((r as any).MAR_DESCRICAO) ?? '',
    }));
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



  /**
   * Locações conhecidas de um produto no cadastro do ERP (explodidas pelas mesmas
   * regras da busca da avulsa). Usada para descobrir as locações que ficaram FORA do
   * escopo de uma avulsa parcial. Falha aqui não pode derrubar a criação da contagem:
   * devolve null e a contagem nasce sem pendências (comportamento antigo).
   */
  private async buscarLocacoesDoProduto(codProduto: number, empresa = '3'): Promise<string[] | null> {
    try {
      const rows = await this.fetchProdutosPorFiltro({
        empresa,
        cod_produto: codProduto,
        somente_com_saldo: false,
      });
      const locs = new Set<string>();
      for (const row of rows) {
        const loc = this.toUtf8Text((row as any).LOCALIZACAO)?.trim();
        if (loc) locs.add(loc);
      }
      return [...locs];
    } catch (e) {
      console.error(`[PENDENTES] Falha ao buscar locações do produto ${codProduto}; contagem segue sem pendências para ele.`, e);
      return null;
    }
  }

  async createContagem(createContagemDto: CreateContagemDto) {
    const {
      colaborador: nomeColaboradorRaw,
      contagem: tipoContagem,
      produtos,
      contagem_cuid,
      piso,
      tipo,
      itens_pendentes_ids
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

    // ANTI DUPLO-CLIQUE: o salvar da tela dispara 3 POSTs e demora alguns segundos; um
    // segundo clique gera um grupo inteiro duplicado com OUTRO cuid (aconteceu em
    // produção: dois grupos idênticos de 71 itens criados com 2s de diferença — e o
    // grupo fantasma ainda poluía a consolidação por produto/dia, acusando divergência
    // em tudo). Mesma rodada + mesmo nome + mesmo colaborador + mesmo tipo criados há
    // menos de 20s = mesma intenção -> devolve a contagem que já existe. A janela é
    // curta de propósito: refazer o assistente inteiro (buscar, selecionar, equipe)
    // leva mais que isso, então criação legítima em sequência não é engolida.
    const nomeContagem = piso != null ? String(piso) : null;
    const duplicada = await this.prisma.est_contagem.findFirst({
      where: {
        colaborador: usuario.id,
        contagem: tipoContagem,
        tipo: tipo ?? 1,
        piso: nomeContagem,
        status: 0,
        created_at: { gte: new Date(Date.now() - 20_000) },
      },
      include: { usuario: { select: { id: true, nome: true, codigo: true } } },
    });

    if (duplicada) {
      console.log(`[ANTI-DUPLO-CLIQUE] Contagem idêntica criada há <60s (cuid=${duplicada.contagem_cuid}, rodada=${tipoContagem}); devolvendo a existente.`);
      const itensExistentes = duplicada.contagem_cuid
        ? await this.prisma.est_contagem_itens.findMany({
            where: { contagem_cuid: duplicada.contagem_cuid },
          })
        : [];
      return { ...duplicada, itens: itensExistentes, pendencias: [] };
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

    const ehAvulsa = (tipo ?? 1) === 2;

    // AVULSA PARCIAL: o Celta não separa saldo por locação, então um produto contado em
    // UMA locação só valida quando as outras também forem contadas. Aqui buscamos as
    // locações completas de cada produto no cadastro (fora da transação — é ida ao ERP)
    // para criar as que ficaram fora do escopo como itens PENDENTES.
    const pendencias: Array<{ cod_produto: number; desc_produto: string; locacoes_pendentes: string[] }> = [];
    const locacoesCompletas = new Map<number, string[]>();
    if (ehAvulsa && produtosSanitizados.length > 0) {
      const jaTemItens = await this.prisma.est_contagem_itens.count({
        where: { contagem_cuid: grupoContagem },
      });
      if (jaTemItens === 0) {
        const codigos = [...new Set(produtosSanitizados.map(p => p.COD_PRODUTO).filter(c => c > 0))];
        for (const cod of codigos) {
          const locs = await this.buscarLocacoesDoProduto(cod);
          if (locs) locacoesCompletas.set(cod, locs);
        }
      }
    }

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
          // 'piso' guarda o NOME da contagem (para avulsa, já vem com prefixo "AVULSA - ").
          piso: piso != null ? String(piso) : null,
          tipo: tipo ?? 1, // 1=Diária/Rotativa, 2=Avulsa
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
        // Agrupa os produtos por (COD_PRODUTO + data do movimento). Cada grupo é um
        // produto/dia que pode ter N localizações — e TODAS precisam compartilhar o
        // MESMO identificador_item para a validação de multilocação (soma das locações
        // x estoque total) funcionar. Antes havia um limite implícito de 2 locações
        // por identificador (slots de 2): a 3ª locação caía em "-v2" e saía do grupo.
        const gruposPorProduto = new Map<string, typeof produtosSanitizados>();
        for (const produto of produtosSanitizados) {
          const dataStr = produto.DATA instanceof Date
            ? produto.DATA.toISOString().slice(0, 10)
            : String(produto.DATA).slice(0, 10);
          const chaveBase = `${produto.COD_PRODUTO}-${dataStr}`;
          const grupo = gruposPorProduto.get(chaveBase);
          if (grupo) grupo.push(produto);
          else gruposPorProduto.set(chaveBase, [produto]);
        }

        // Criar os itens associados ao contagem_cuid — um identificador por grupo.
        for (const [chaveBase, produtosDoGrupo] of gruposPorProduto) {
          // Encontra uma versão de identificador ainda NÃO usada por outra sessão de
          // contagem do mesmo produto/dia (evita colisão/mistura de logs entre sessões).
          let targetIdentificador = chaveBase;
          let version = 1;
          while (true) {
            const usageCount = await tx.est_contagem_itens.count({
              where: { identificador_item: targetIdentificador }
            });

            if (usageCount === 0) {
              // Identificador livre para esta sessão.
              break;
            }

            // Já usado por uma sessão anterior. Tenta a próxima versão.
            version++;
            targetIdentificador = `${chaveBase}-v${version}`;
          }

          if (version > 1) {
            console.log(`[AUTO-VERSION] Produto/dia ${chaveBase} já contado em outra sessão. Gerando versão: ${targetIdentificador}`);
          }

          // Itens que este produto/dia já tem em OUTRAS sessões ativas (avulsa): uma
          // locação não pode existir duas vezes no consolidado — se existisse, um
          // fantasma duplicado nunca seria contado e o produto ficaria aguardando para
          // sempre. Locação selecionada que já existe como fantasma é ADOTADA; fantasma
          // só nasce para locação que ainda não existe em lugar nenhum.
          let fantasmaPorLocacao = new Map<string, { id: string }>();
          const locacoesJaExistentes = new Set<string>();
          if (ehAvulsa) {
            const base = produtosDoGrupo[0];
            const diaIni = new Date(base.DATA);
            diaIni.setUTCHours(0, 0, 0, 0);
            const diaFim = new Date(base.DATA);
            diaFim.setUTCHours(23, 59, 59, 999);

            const existentes = await tx.est_contagem_itens.findMany({
              where: {
                cod_produto: base.COD_PRODUTO,
                data: { gte: diaIni, lte: diaFim },
              },
              select: { id: true, localizacao: true, pendente: true, contagem_cuid: true, logs: { select: { id: true }, take: 1 } },
            });

            if (existentes.length > 0) {
              const cuidsExistentes = [...new Set(existentes.map((e) => e.contagem_cuid))];
              const sessoesAtivas = await tx.est_contagem.findMany({
                where: { contagem_cuid: { in: cuidsExistentes }, status: 0 },
                select: { contagem_cuid: true },
              });
              const cuidsAtivos = new Set(sessoesAtivas.map((s) => s.contagem_cuid));

              for (const e of existentes) {
                if (!cuidsAtivos.has(e.contagem_cuid)) continue;
                const key = (e.localizacao ?? '').toUpperCase().trim();
                if (!key) continue;
                locacoesJaExistentes.add(key);
                if (e.pendente && e.logs.length === 0) {
                  fantasmaPorLocacao.set(key, { id: e.id });
                }
              }
            }
          }

          // Todas as N localizações deste produto/dia recebem o MESMO identificador.
          for (const produto of produtosDoGrupo) {
            const locKey = (produto.LOCALIZACAO ?? '').toUpperCase().trim();
            const fantasma = fantasmaPorLocacao.get(locKey);
            if (fantasma) {
              // A locação selecionada já existe como pendente de outra avulsa do mesmo
              // dia: adota o item em vez de duplicar a locação no consolidado.
              const adotado = await tx.est_contagem_itens.update({
                where: { id: fantasma.id },
                data: { contagem_cuid: grupoContagem, pendente: false, conferir: true },
              });
              fantasmaPorLocacao.delete(locKey);
              itens.push(adotado);
              continue;
            }

            const item = await tx.est_contagem_itens.create({
              data: {
                identificador_item: targetIdentificador,
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

          // AVULSA PARCIAL: locações do cadastro que ficaram fora da seleção viram itens
          // PENDENTES da mesma sessão (mesmo identificador e mesma data — é isso que
          // permite à consolidação enxergar o produto/dia inteiro). Elas não aparecem
          // para o contador; ficam aguardando uma avulsa complementar que as adote.
          if (ehAvulsa) {
            const base = produtosDoGrupo[0];
            const todas = locacoesCompletas.get(base.COD_PRODUTO) ?? [];
            const selecionadas = new Set(
              produtosDoGrupo
                .map((p) => (p.LOCALIZACAO ?? '').toUpperCase().trim())
                .filter(Boolean),
            );
            const faltantes = todas.filter((loc) => {
              const key = loc.toUpperCase().trim();
              // Fora se foi selecionada agora OU se já existe (contada ou pendente) em
              // outra sessão ativa do mesmo produto/dia.
              return !selecionadas.has(key) && !locacoesJaExistentes.has(key);
            });

            for (const loc of faltantes) {
              const item = await tx.est_contagem_itens.create({
                data: {
                  identificador_item: targetIdentificador,
                  contagem_cuid: grupoContagem,
                  data: base.DATA,
                  cod_produto: base.COD_PRODUTO,
                  desc_produto: base.DESC_PRODUTO ?? '',
                  mar_descricao: base.MAR_DESCRICAO,
                  ref_fabricante: base.REF_FABRICANTE,
                  ref_fornecedor: base.REF_FORNECEDOR,
                  localizacao: loc,
                  unidade: base.UNIDADE,
                  aplicacoes: null,
                  qtde_saida: 0,
                  estoque: base.ESTOQUE,
                  reserva: base.RESERVA,
                  pendente: true,
                  conferir: false,
                },
              });
              itens.push(item);
            }

            if (faltantes.length > 0) {
              pendencias.push({
                cod_produto: base.COD_PRODUTO,
                desc_produto: base.DESC_PRODUTO ?? '',
                locacoes_pendentes: faltantes,
              });
            }
          }
        }

        // ADOÇÃO DE PENDENTES: itens que outra avulsa deixou aguardando entram nesta
        // sessão. O item MUDA de sessão (contagem_cuid novo) mas conserva data e
        // identificador — assim a contagem feita aqui fecha a consolidação do
        // produto/dia da sessão de origem.
        if (ehAvulsa && Array.isArray(itens_pendentes_ids) && itens_pendentes_ids.length > 0) {
          const adotaveis = await tx.est_contagem_itens.findMany({
            where: {
              id: { in: itens_pendentes_ids },
              pendente: true,
              logs: { none: {} },
            },
          });

          for (const itemPendente of adotaveis) {
            const adotado = await tx.est_contagem_itens.update({
              where: { id: itemPendente.id },
              data: { contagem_cuid: grupoContagem, pendente: false, conferir: true },
            });
            itens.push(adotado);
          }

          if (adotaveis.length < itens_pendentes_ids.length) {
            console.log(
              `[PENDENTES] ${itens_pendentes_ids.length - adotaveis.length} item(ns) não adotado(s): já contados, já adotados ou inexistentes.`,
            );
          }
        }
      } else {
        itens = itensExistentes;
      }

      return { ...contagem, itens };
    });

    // `pendencias` alimenta o aviso da tela: "esses produtos têm locações que ficaram
    // pendentes de contagem". Vazio na diária e quando o produto só tem uma locação.
    return { ...contagemResult, pendencias };
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

    // Buscar os itens separadamente usando contagem_cuid.
    // Itens PENDENTES ficam fora da lista do contador: são locações que a avulsa
    // deliberadamente deixou para uma contagem complementar — quem os conta é a
    // sessão que os adotar (aí deixam de ser pendentes e aparecem).
    const contagensComItens = await Promise.all(
      contagens.map(async (contagem) => {
        if (contagem.contagem_cuid) {
          const itens = await this.prisma.est_contagem_itens.findMany({
            where: {
              contagem_cuid: contagem.contagem_cuid,
              pendente: false
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
    // O produto pode ter locações espalhadas por SESSÕES diferentes (pisos/CUIDs
    // distintos, portanto identificador_item distinto). Por isso a validação olha o
    // produto/dia inteiro — só assim "locação A certa + locação B certa" fecha com o
    // estoque total do sistema.
    const consolidado = await consolidarProdutoDia(
      this.prisma,
      contagemItem.cod_produto,
      contagemItem.data,
      { estoqueReferencia: estoqueRealtime },
    );

    const rodadaAtual = parentContagem?.contagem;
    const totalLocacoes = consolidado?.locacoes.length ?? 1;

    let finalConferirValue = temDivergenciaNumerica; // Default: Back decide (segurança)
    let escopoUpdate: Prisma.est_contagem_itensWhereInput = { identificador_item: identificador_item };

    if (totalLocacoes <= 1) {
      // CASO 1: Locação Única -> CONFIA NO FRONT
      // O usuário sabe o que está vendo. Se ele marcou que tem divergência, tem. Se não, não.
      console.log(`[DEBUG] HybridValidation: Trusting Frontend value=${conferir}`);
      finalConferirValue = conferir;
    } else if (consolidado?.correto) {
      // CASO 2: Multilocação já fechada com o estoque (uma rodada INTEIRA bateu — a
      // validação nunca mistura rodadas) -> NENHUMA locação segue para as próximas
      // contagens, inclusive as que estão em outras sessões.
      console.log(`[DEBUG] HybridValidation: Produto fechado -> ${consolidado.motivo}`);
      finalConferirValue = false;
      escopoUpdate = { id: { in: consolidado.itens_ids } };
    } else if (consolidado && rodadaAtual && this.rodadaCoberta(consolidado, rodadaAtual)) {
      // CASO 3: Multilocação com TODAS as locações já contadas nesta rodada e a soma não
      // fechou -> divergência confirmada pelo BACK.
      console.log(`[DEBUG] HybridValidation: Enforcing Backend value=true (soma ${consolidado.rodadas[rodadaAtual as Rodada].total} x estoque ${consolidado.estoque_referencia})`);
      finalConferirValue = true;
    } else if (consolidado?.status === 'aguardando_pendentes') {
      // CASO 3b: Avulsa parcial com o escopo todo contado — só faltam as locações
      // PENDENTES (deixadas de propósito para outra contagem). A soma parcial não pode
      // ser comparada ao estoque total, então não há divergência a marcar.
      console.log(`[DEBUG] HybridValidation: Aguardando pendentes -> ${consolidado.motivo}`);
      finalConferirValue = false;
    } else {
      // CASO 4: Ainda falta contar alguma locação (possivelmente em outra sessão).
      // Sem o total não dá para validar -> CONFIA NO FRONT (status provisório).
      console.log(`[DEBUG] HybridValidation: Locações pendentes, trusting Frontend value=${conferir}`);
      finalConferirValue = conferir;
    }

    // ATUALIZAÇÃO EM MASSA:
    const updated = await this.prisma.est_contagem_itens.updateMany({
      where: escopoUpdate,
      data: { conferir: finalConferirValue },
    });

    // Se o produto fechou, as outras sessões que já haviam sido liberadas para a 2ª/3ª
    // contagem por causa dele não têm mais o que recontar.
    if (consolidado?.correto) {
      for (const cuidIrmao of consolidado.cuids) {
        if (cuidIrmao === parentContagem?.contagem_cuid) continue;
        await this.revogarLiberacoesSemDivergencia(cuidIrmao);
      }
    }

    // Retorna um dos itens atualizados
    return await this.prisma.est_contagem_itens.findFirst({
      where: { id: itemId }
    });
  }

  /** true quando TODAS as locações do produto/dia foram contadas na rodada informada. */
  private rodadaCoberta(consolidado: ConsolidadoProdutoDia, rodada: number): boolean {
    if (rodada !== 1 && rodada !== 2 && rodada !== 3) return false;
    return consolidado.rodadas[rodada as Rodada].cobertura_total;
  }

  /**
   * "Chama de volta" as contagens 2/3 de uma sessão que foram liberadas por engano.
   *
   * Cenário: a sessão A concluiu ANTES de a sessão B contar a outra locação do mesmo
   * produto. Somando só a locação de A a conta não fechava, então A foi liberada para a
   * 2ª contagem. Quando B conta a outra locação e o produto fecha com o estoque, A não
   * tem mais nada para recontar.
   *
   * Só revoga rodadas que ainda NÃO foram iniciadas (sem nenhum log) e nunca a 1ª
   * contagem — trabalho já feito não é desfeito.
   */
  private async revogarLiberacoesSemDivergencia(contagem_cuid: string) {
    if (!contagem_cuid) return;

    const pendentes = await this.prisma.est_contagem_itens.count({
      where: { contagem_cuid: contagem_cuid, conferir: true },
    });

    if (pendentes > 0) return;

    const rodadasLiberadas = await this.prisma.est_contagem.findMany({
      where: {
        contagem_cuid: contagem_cuid,
        contagem: { gt: 1 },
        liberado_contagem: true,
        status: 0,
      },
      select: { id: true, contagem: true, _count: { select: { logs: true } } },
    });

    const idsSemLogs = rodadasLiberadas.filter(r => r._count.logs === 0).map(r => r.id);
    if (idsSemLogs.length === 0) return;

    await this.prisma.est_contagem.updateMany({
      where: { id: { in: idsSemLogs } },
      data: { liberado_contagem: false },
    });

    console.log(`[DEBUG] revogarLiberacoes: CUID=${contagem_cuid} -> ${idsSemLogs.length} rodada(s) fechada(s) por não haver mais divergência.`);
  }

  async getEstoqueProduto(codProduto: number, empresa: string = '3'): Promise<ConferirEstoqueResponseDto | null> {
    // Sanitização adicional
    if (!/^\d+$/.test(empresa)) {
      throw new BadRequestException('Empresa inválida');
    }
    // O valor entra no literal Firebird: só inteiro passa.
    if (!Number.isInteger(Number(codProduto))) {
      throw new BadRequestException('Código de produto inválido');
    }

    return this.erpApi.comFallback(
      async () => {
        const linha = await this.erpApi.estoqueProduto(Number(codProduto), Number(empresa));
        if (!linha) return null;
        // Mesmas chaves que o driver devolvia (o Firebird responde em MAIÚSCULAS):
        // quem consome lê `.ESTOQUE`, e o contrato não muda com a troca de caminho.
        return {
          PRO_CODIGO: Number(linha.PRO_CODIGO),
          ESTOQUE: Number(linha.ESTOQUE_DISPONIVEL),
        } as unknown as ConferirEstoqueResponseDto;
      },
      () => this.getEstoqueProdutoViaOpenQuery(codProduto, empresa),
    );
  }

  /**
   * A conferência pergunta produto a produto. Pela API, as chamadas unitárias
   * que chegam juntas viram um único SELECT com IN do outro lado; por aqui,
   * cada uma é uma ida ao Firebird.
   */
  private async getEstoqueProdutoViaOpenQuery(codProduto: number, empresa: string): Promise<ConferirEstoqueResponseDto | null> {

    // ESTOQUE_DISPONIVEL é coluna de PRODUTOS: o saldo sai daqui direto.
    //
    // A versão anterior chegava nele por LANCTOS_ESTOQUE e MARCAS, e o efeito
    // não era lentidão — era resposta faltando. Os dois joins eram INNER, então
    // produto sem movimentação ou sem marca devolvia ZERO linhas, e quem chama
    // interpreta null como "não consegui saber o estoque" e usa o snapshot
    // antigo da contagem. O saldo aparecia desatualizado sem nenhum erro no log.
    const innerSql = [
      'SELECT',
      '    PRO.PRO_CODIGO,',
      '    PRO.ESTOQUE_DISPONIVEL AS ESTOQUE',
      'FROM PRODUTOS PRO',
      `WHERE PRO.EMPRESA = '${empresa}'`,
      `    AND PRO.PRO_CODIGO = ${codProduto}`,
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
    itensParaRevalidar: string[] = [],
    data_fim?: string
  ) {
    // Fim da contagem = clique em "Concluir". Usa o horário do dispositivo quando válido.
    let dataFim = data_fim ? new Date(data_fim) : new Date();
    if (isNaN(dataFim.getTime())) dataFim = new Date();
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

    // Sempre trava a contagem atual (liberado_contagem = false) e grava o fim.
    await this.prisma.est_contagem.updateMany({
      where: {
        contagem_cuid: contagem_cuid,
        contagem: contagem,
      },
      data: { liberado_contagem: false, data_fim: dataFim },
    });

    // Se está na contagem 3, não há próxima para liberar
    if (contagem === 3) {
      await this.reconciliarProdutosDaSessao(contagem_cuid);
      return await this.prisma.est_contagem.updateMany({
        where: {
          contagem_cuid: contagem_cuid,
          contagem: contagem,
        },
        data: { liberado_contagem: false },
      });
    }

    // VALIDAÇÃO CONSOLIDADA (produto/dia, todas as locações de todas as sessões).
    // O flag `divergencia` que vem do front enxerga apenas as locações desta sessão. Se o
    // mesmo produto está em outro piso/sessão, essa visão é parcial nos dois sentidos:
    //  - pode acusar divergência que a outra locação já resolveu (aí NÃO se libera nada);
    //  - pode dar tudo certo aqui e faltar locação lá (aí a divergência continua valendo).
    const { algumProdutoDivergente, temItens } = await this.reconciliarProdutosDaSessao(contagem_cuid);

    const temDivergenciaReal = temItens ? algumProdutoDivergente : divergencia;

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

    // Se não há divergência, só trava o atual e não libera o próximo.
    // Se alguma rodada seguinte tinha sido liberada antes (por uma conclusão anterior que
    // ainda não enxergava a outra locação), ela é fechada aqui.
    await this.revogarLiberacoesSemDivergencia(contagem_cuid);

    return await this.prisma.est_contagem.findFirst({
      where: {
        contagem_cuid: contagem_cuid,
        contagem: contagem,
      },
    });
  }

  /**
   * Reavalia todos os produtos de uma sessão olhando o produto/dia INTEIRO — todas as
   * locações, inclusive as que estão em outras sessões (outro piso, outro CUID).
   *
   * - Produto que fechou com o estoque: `conferir = false` em TODAS as locações (as desta
   *   sessão e as das outras), e as rodadas que as outras sessões tinham aberto por causa
   *   dele são fechadas se ainda não foram iniciadas.
   * - Produto que não fechou: `conferir = true` nas locações desta sessão, que segue para
   *   a próxima contagem.
   */
  private async reconciliarProdutosDaSessao(
    contagem_cuid: string,
  ): Promise<{ algumProdutoDivergente: boolean; temItens: boolean }> {
    const itens = await this.prisma.est_contagem_itens.findMany({
      where: { contagem_cuid: contagem_cuid },
      select: { id: true, cod_produto: true, data: true },
    });

    if (itens.length === 0) {
      return { algumProdutoDivergente: false, temItens: false };
    }

    // Agrupa as locações desta sessão por produto/dia (a chave usada na consolidação).
    const grupos = new Map<string, { cod_produto: number; data: Date; itensIds: string[] }>();
    for (const item of itens) {
      const chave = `${item.cod_produto}-${item.data.toISOString().slice(0, 10)}`;
      const grupo = grupos.get(chave);
      if (grupo) grupo.itensIds.push(item.id);
      else grupos.set(chave, { cod_produto: item.cod_produto, data: item.data, itensIds: [item.id] });
    }

    let algumProdutoDivergente = false;
    const cuidsIrmaos = new Set<string>();

    for (const grupo of grupos.values()) {
      const consolidado = await consolidarProdutoDia(this.prisma, grupo.cod_produto, grupo.data);
      if (!consolidado) continue;

      if (consolidado.correto) {
        await this.prisma.est_contagem_itens.updateMany({
          where: { id: { in: consolidado.itens_ids } },
          data: { conferir: false },
        });

        for (const cuid of consolidado.cuids) {
          if (cuid !== contagem_cuid) cuidsIrmaos.add(cuid);
        }

        console.log(`[DEBUG] reconciliar: produto ${grupo.cod_produto} OK -> ${consolidado.motivo}`);
      } else if (consolidado.status === 'aguardando_pendentes') {
        // Avulsa parcial: as locações do escopo foram contadas, mas o produto tem
        // locações pendentes sem contagem. A soma é parcial por definição — não é
        // divergência e o produto NÃO segue para a 2ª/3ª contagem. Desmarca `conferir`
        // (o app pode ter marcado provisoriamente, já que ele só enxerga a soma parcial).
        await this.prisma.est_contagem_itens.updateMany({
          where: { id: { in: grupo.itensIds } },
          data: { conferir: false },
        });

        console.log(`[DEBUG] reconciliar: produto ${grupo.cod_produto} PENDENTE -> ${consolidado.motivo}`);
      } else {
        algumProdutoDivergente = true;
        await this.prisma.est_contagem_itens.updateMany({
          where: { id: { in: grupo.itensIds } },
          data: { conferir: true },
        });
      }
    }

    for (const cuidIrmao of cuidsIrmaos) {
      await this.revogarLiberacoesSemDivergencia(cuidIrmao);
    }

    return { algumProdutoDivergente, temItens: true };
  }

  /**
   * Itens PENDENTES disponíveis para adoção: locações que avulsas anteriores deixaram
   * fora do escopo, ainda sem nenhuma contagem, de sessões ativas. É a lista que a tela
   * "buscar pendentes de outra avulsa" mostra.
   */
  async getItensPendentes() {
    const itens = await this.prisma.est_contagem_itens.findMany({
      where: { pendente: true, logs: { none: {} } },
      orderBy: [{ cod_produto: 'asc' }],
    });

    if (itens.length === 0) return [];

    // Só valem pendências de sessão ativa; o nome da contagem de origem (coluna
    // 'piso') vai junto para o usuário saber de onde a pendência veio.
    const cuids = [...new Set(itens.map(i => i.contagem_cuid))];
    const sessoes = await this.prisma.est_contagem.findMany({
      where: { contagem_cuid: { in: cuids }, status: 0, tipo: 2 },
      select: { contagem_cuid: true, piso: true, created_at: true },
    });

    const sessaoPorCuid = new Map<string, { piso: string | null; created_at: Date }>();
    for (const s of sessoes) {
      if (s.contagem_cuid && !sessaoPorCuid.has(s.contagem_cuid)) {
        sessaoPorCuid.set(s.contagem_cuid, { piso: s.piso, created_at: s.created_at });
      }
    }

    return itens
      .filter(i => sessaoPorCuid.has(i.contagem_cuid))
      .map(i => ({
        ...i,
        contagem_origem: sessaoPorCuid.get(i.contagem_cuid)?.piso ?? null,
        criada_em: sessaoPorCuid.get(i.contagem_cuid)?.created_at ?? null,
      }));
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
      // 'piso' guarda o nome da contagem; busca por parte do nome (case-insensitive).
      whereClause.piso = { contains: piso, mode: 'insensitive' };
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
          // status: 0
        },
        include: { logs: true }
      });

      // TRAVA: Verificar se ALGUMA contagem do grupo já foi iniciada (tem logs)
      const algumIniciado = grupoContagens.some(c => Array.isArray(c.logs) && c.logs.length > 0);

      if (algumIniciado) {
        // Se qualquer uma do grupo (1, 2 ou 3) tiver logs, BLOQUEIA A EXCLUSÃO DE TODAS.
        // Motivo: "As contagens sempre são conjunto de 3". Não podemos quebrar o conjunto.
        // O usuário solicitou explicitamente essa trava: se iniciado, permite apenas edição, não exclusão.
        throw new BadRequestException('Não é possível excluir. O grupo de contagens já foi iniciado.');
      }

      // Se NENHUMA foi iniciada, exclui TODAS (status = 1)
      const idsParaExcluir = grupoContagens.map(c => c.id);

      if (idsParaExcluir.length > 0) {
        const resultado = await this.prisma.est_contagem.updateMany({
          where: { id: { in: idsParaExcluir } },
          data: {
            liberado_contagem: false,
            status: 1,
          }
        });

        // O grupo excluído some da consolidação — mas as sessões que compartilhavam
        // produto/dia com ele podem ter sido dadas como divergentes por causa das
        // locações dele (ex.: grupo duplicado por duplo-clique: os itens sem contagem
        // do fantasma impediam qualquer rodada de fechar). Reavalia essas sessões para
        // limpar `conferir` e recolher rodadas liberadas sem necessidade.
        await this.reavaliarSessoesVizinhas(contagemAlvo.contagem_cuid);

        return resultado;
      }

    } else {
      // Fallback: Sem CUID (isolada), verifica apenas ela mesma
      if (contagemAlvo.logs.length > 0) {
        throw new BadRequestException('Não é possível excluir uma contagem já iniciada (possui registros).');
      }

      return await this.prisma.est_contagem.update({
        where: { id },
        data: {
          liberado_contagem: false,
          status: 1,
        }
      });
    }

    return { count: 0, message: "Nenhuma contagem excluída" };
  }

  /**
   * Reavalia as sessões que compartilhavam produto/dia com um grupo recém-excluído.
   * Para cada vizinha ativa: reconsolida os produtos (conferir volta a refletir a
   * realidade sem as locações do grupo excluído) e recolhe rodadas liberadas que
   * ficaram sem divergência para justificá-las.
   */
  private async reavaliarSessoesVizinhas(contagemCuidExcluido: string | null) {
    if (!contagemCuidExcluido) return;

    const itensDoGrupo = await this.prisma.est_contagem_itens.findMany({
      where: { contagem_cuid: contagemCuidExcluido },
      select: { cod_produto: true, data: true },
    });
    if (itensDoGrupo.length === 0) return;

    // Produto/dia distintos do grupo excluído.
    const chaves = new Map<string, { cod: number; ini: Date; fim: Date }>();
    for (const item of itensDoGrupo) {
      const dia = item.data.toISOString().slice(0, 10);
      const chave = `${item.cod_produto}-${dia}`;
      if (chaves.has(chave)) continue;
      const ini = new Date(item.data);
      ini.setUTCHours(0, 0, 0, 0);
      const fim = new Date(item.data);
      fim.setUTCHours(23, 59, 59, 999);
      chaves.set(chave, { cod: item.cod_produto, ini, fim });
    }

    const cuidsVizinhos = new Set<string>();
    for (const { cod, ini, fim } of chaves.values()) {
      const rows = await this.prisma.est_contagem_itens.findMany({
        where: {
          cod_produto: cod,
          data: { gte: ini, lte: fim },
          NOT: { contagem_cuid: contagemCuidExcluido },
        },
        select: { contagem_cuid: true },
        distinct: ['contagem_cuid'],
      });
      for (const r of rows) {
        if (r.contagem_cuid) cuidsVizinhos.add(r.contagem_cuid);
      }
    }

    for (const cuid of cuidsVizinhos) {
      try {
        await this.reconciliarProdutosDaSessao(cuid);
        await this.revogarLiberacoesSemDivergencia(cuid);
        console.log(`[EXCLUSAO] Sessão vizinha ${cuid} reavaliada após exclusão de ${contagemCuidExcluido}.`);
      } catch (e) {
        // Reavaliação é saneamento: falhar aqui não pode desfazer a exclusão.
        console.error(`[EXCLUSAO] Falha ao reavaliar sessão vizinha ${cuid}`, e);
      }
    }
  }

  async updateContagemGrupo(
    contagemCuid: string,
    data: {
      piso?: string;
      contagem1UsuarioId?: string;
      contagem2UsuarioId?: string;
      contagem3UsuarioId?: string;
    }
  ) {
    const grupoContagens = await this.prisma.est_contagem.findMany({
      where: {
        contagem_cuid: contagemCuid,
        status: 0,
      },
      include: { logs: { select: { id: true } } },
    });

    if (grupoContagens.length === 0) {
      throw new BadRequestException('Grupo de contagem nao encontrado');
    }

    const grupoIniciado = grupoContagens.some(
      (c) => Array.isArray(c.logs) && c.logs.length > 0,
    );

    if (grupoIniciado) {
      throw new BadRequestException('Nao e possivel alterar. O grupo de contagens ja foi iniciado.');
    }

    const colaboradorPorContagem: Record<number, string | undefined> = {
      1: data.contagem1UsuarioId,
      2: data.contagem2UsuarioId,
      3: data.contagem3UsuarioId,
    };

    const updates = grupoContagens.map((contagem) => {
      const novoColaborador = colaboradorPorContagem[contagem.contagem];
      return this.prisma.est_contagem.update({
        where: { id: contagem.id },
        data: {
          ...(typeof data.piso !== 'undefined' ? { piso: data.piso } : {}),
          ...(typeof novoColaborador !== 'undefined' ? { colaborador: novoColaborador } : {}),
        },
      });
    });

    await this.prisma.$transaction(updates);

    return this.prisma.est_contagem.findMany({
      where: {
        contagem_cuid: contagemCuid,
        status: 0,
      },
      include: {
        usuario: {
          select: { id: true, nome: true, codigo: true },
        },
      },
      orderBy: { contagem: 'asc' },
    });
  }

  /**
   * Grava o início da contagem (data_inicio) na PRIMEIRA quantidade contada.
   * Regras:
   *  - só grava se ainda estiver vazio; OU
   *  - se o horário informado for MAIS ANTIGO que o já gravado (sync fora de ordem).
   * Usa o horário real do dispositivo (client_time) quando válido; senão, now().
   */
  private async marcarInicioContagem(contagemId: string, clientTime?: string) {
    try {
      const contagem = await this.prisma.est_contagem.findUnique({
        where: { id: contagemId },
        select: { data_inicio: true },
      });
      if (!contagem) return;

      let momento = clientTime ? new Date(clientTime) : new Date();
      if (isNaN(momento.getTime())) momento = new Date();

      const inicioAtual = contagem.data_inicio;
      if (!inicioAtual || momento < inicioAtual) {
        await this.prisma.est_contagem.update({
          where: { id: contagemId },
          data: { data_inicio: momento },
        });
      }
    } catch (e) {
      // Início é métrica auxiliar (para KPIs); nunca deve quebrar o registro do log.
      console.error('[marcarInicioContagem] Falha ao gravar data_inicio', e);
    }
  }

  async createLog(createLogData: {
    contagem_id: string;
    usuario_id: string;
    item_id: string;
    estoque: number;
    contado: number;
    identificador_item?: string;
    client_time?: string;
  }) {
    // Marca o INÍCIO da contagem no momento da PRIMEIRA quantidade contada.
    // Como o app é offline-first, usamos o horário REAL do dispositivo (client_time)
    // — que pode ser bem anterior ao horário de sincronização. Só grava se ainda não
    // houver início, ou se este log for mais antigo (sync fora de ordem).
    await this.marcarInicioContagem(createLogData.contagem_id, createLogData.client_time);

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
