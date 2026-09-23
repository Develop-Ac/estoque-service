import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/* =============================================================================
   CLIENTE DA erp-firebird-api
   -----------------------------------------------------------------------------
   Caminho de leitura do ERP que NÃO passa pelo SQL Server. Hoje toda consulta
   ao Celta sai daqui por OPENQUERY(CONSULTA): o SQL Server abre uma sessão no
   Firebird, e quando essa sessão trava — ou quando o linked server engasga — a
   contagem para junto, mesmo com o ERP saudável.

   Do lado de lá o SELECT é montado a partir do catálogo: nome de coluna é
   validado contra os metadados, valor viaja como parâmetro, e o filtro de
   EMPRESA é obrigatório nas tabelas que têm a coluna.

   O que mais importa para a contagem:

     - as tabelas de apoio (marcas, grupos, subgrupos) têm cache de 5 minutos
       lá. Hoje cada abertura da tela de filtro custa três consultas ao ERP;
     - a consulta de saldo é feita item a item quando a contagem é conferida, e
       as chamadas unitárias que chegam juntas são agrupadas num único SELECT
       com IN.

   MIGRAÇÃO SEM JANELA: cada chamada tem o caminho antigo como alternativa. Sem
   `ERP_API_URL` configurada, nada muda de comportamento; com ela, o OPENQUERY
   vira plano B e o log diz sempre que caiu para ele.
   ============================================================================= */

/** Envelope de resposta da erp-firebird-api. */
interface RespostaErp {
  dados: any[];
  meta: {
    tabela: string;
    linhas: number;
    ms: number;
    /** Bateu no teto da tabela: falta filtro, ou a lista precisa ser paginada. */
    truncado: boolean;
    cache: boolean;
  };
}

export interface FiltroProdutos {
  empresa: string;
  cod_produto?: number;
  /** Vários códigos numa consulta só (`PRO_CODIGO:em:...`, teto de 500 valores). */
  cod_produtos?: number[];
  marca?: number;
  grupo?: number;
  subgrupo?: number;
  /** Versões multi-seleção (viram `:em:` — funciona também na relação grupo.GRP_CODIGO). */
  marcas?: number[];
  grupos?: number[];
  subgrupos?: number[];
  descricao?: string;
}

@Injectable()
export class ErpApiService {
  private readonly logger = new Logger(ErpApiService.name);

  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  /**
   * Breaker de saída. Quando a API está fora, insistir custa o timeout inteiro
   * a cada chamada — e o caminho de OPENQUERY, que funciona, só começa depois
   * disso. Passadas as falhas seguidas, para de tentar por um tempo e vai
   * direto para o plano B.
   */
  private falhasSeguidas = 0;
  private mudoAte = 0;
  private static readonly LIMITE_FALHAS = 3;
  private static readonly COOLDOWN_MS = 60_000;

  constructor(private readonly config: ConfigService) {
    this.base = String(this.config.get('ERP_API_URL') ?? '').trim().replace(/\/+$/, '');
    this.token = String(this.config.get('ERP_API_TOKEN') ?? '').trim();
    this.timeoutMs = Number(this.config.get('ERP_API_TIMEOUT_MS') ?? 60_000);

    if (this.base) {
      this.logger.log(`[ERP-API] leitura do ERP habilitada em ${this.base}`);
    } else {
      this.logger.log('[ERP-API] ERP_API_URL não configurada — leitura do ERP segue por OPENQUERY.');
    }
  }

  /** Só chama a API quem tem para onde chamar, e fora do período de cooldown. */
  get habilitado(): boolean {
    if (!this.base) return false;
    return Date.now() >= this.mudoAte;
  }

  /* ------------------------------ transporte ------------------------------- */

  private async pedir(
    caminho: string,
    params: Record<string, any> = {},
    opts: { exigirCompleto?: boolean; checarTruncado?: boolean } = {},
  ): Promise<any[]> {
    const url = new URL(this.base + caminho);
    for (const [chave, valor] of Object.entries(params)) {
      if (valor === undefined || valor === null || valor === '') continue;
      // `f` é repetível: cada filtro vai no seu próprio parâmetro. Juntar dois
      // filtros numa string só faria o segundo virar valor do primeiro, porque
      // o operador `em` também usa vírgula.
      for (const item of Array.isArray(valor) ? valor : [valor]) {
        url.searchParams.append(chave, String(item));
      }
    }

    try {
      const resposta = await fetch(url, {
        headers: {
          'x-app-token': this.token,
          // O relatório /health/n1 do outro lado é por serviço: sem este header
          // o padrão de consulta unitária aparece como "desconhecido".
          'x-servico': 'estoque-service',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        throw new Error(`HTTP ${resposta.status} em ${caminho}: ${corpo.slice(0, 300)}`);
      }

      const json = (await resposta.json()) as RespostaErp;
      this.falhasSeguidas = 0;

      // Truncamento silencioso, numa contagem, é o pior desfecho: a lista parece
      // completa e os produtos que ficaram de fora simplesmente não são
      // contados. Onde isso importa, o erro devolve a chamada para o caminho
      // antigo, que não tem teto.
      if (json?.meta?.truncado && opts.checarTruncado !== false) {
        const aviso = `${caminho} bateu no teto da tabela (${json.meta.linhas} linhas) e o resultado está INCOMPLETO`;
        if (opts.exigirCompleto) throw new Error(aviso);
        this.logger.warn(`[ERP-API] ${aviso} — reduza o período ou o filtro.`);
      }

      return json?.dados ?? [];
    } catch (erro: any) {
      this.registrarFalha(caminho, erro);
      throw erro;
    }
  }

  /**
   * Motivo da falha em uma linha.
   *
   * `fetch` embrulha qualquer problema de rede numa mensagem única — "fetch
   * failed" — e joga a causa real no `cause`. Sem abrir esse nível, o log não
   * distingue nome que não resolve de porta fechada, de certificado recusado,
   * e cada um deles pede uma correção diferente.
   */
  private motivo(erro: any): string {
    if (erro?.name === 'TimeoutError' || erro?.name === 'AbortError') {
      return `timeout de ${this.timeoutMs}ms`;
    }

    // Quando o host tem IPv4 e IPv6, o Node tenta os dois e embrulha as duas
    // falhas num AggregateError — que não tem `code`. O motivo está nos filhos.
    let causa: any = erro?.cause;
    if (Array.isArray(causa?.errors) && causa.errors.length) causa = causa.errors[0];

    const codigo = causa?.code ?? causa?.errno;
    if (!codigo) return causa?.message || erro?.message || String(erro);

    const onde = causa?.hostname ?? causa?.address;
    const porta = causa?.port ? `:${causa.port}` : '';
    const explicacao: Record<string, string> = {
      ENOTFOUND: 'o nome não resolve neste container',
      EAI_AGAIN: 'o DNS não respondeu',
      ECONNREFUSED: 'o endereço resolve, mas ninguém atende nessa porta',
      ECONNRESET: 'a conexão foi cortada pelo outro lado',
      ETIMEDOUT: 'o pacote saiu e não voltou — normalmente firewall ou host errado',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado autoassinado: não foi emitido pela CA interna',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'falta a CA interna no container (NODE_EXTRA_CA_CERTS)',
      SELF_SIGNED_CERT_IN_CHAIN: 'falta a CA interna no container (NODE_EXTRA_CA_CERTS)',
    };

    const detalhe = explicacao[codigo] ? ` — ${explicacao[codigo]}` : '';
    return `${codigo}${onde ? ` em ${onde}${porta}` : ''}${detalhe}`;
  }

  private registrarFalha(caminho: string, erro: any) {
    this.falhasSeguidas++;
    const motivo = this.motivo(erro);

    if (this.falhasSeguidas >= ErpApiService.LIMITE_FALHAS) {
      this.mudoAte = Date.now() + ErpApiService.COOLDOWN_MS;
      this.falhasSeguidas = 0;
      this.logger.error(
        `[ERP-API] ${caminho} falhou ${ErpApiService.LIMITE_FALHAS}x seguidas (${motivo}). ` +
          `Pausando por ${ErpApiService.COOLDOWN_MS / 1000}s — as leituras vão por OPENQUERY nesse período.`,
      );
    } else {
      this.logger.warn(`[ERP-API] ${caminho} falhou (${motivo}). Tentando pelo OPENQUERY.`);
    }
  }

  /**
   * Executa pela API e cai para o caminho antigo se ela não responder.
   *
   * A contagem não pode depender da disponibilidade de mais um serviço:
   * enquanto os dois caminhos existem, indisponibilidade da API é degradação,
   * não interrupção.
   */
  async comFallback<T>(viaApi: () => Promise<T>, viaOpenQuery: () => Promise<T>): Promise<T> {
    if (!this.habilitado) return viaOpenQuery();
    try {
      return await viaApi();
    } catch {
      return viaOpenQuery();
    }
  }

  /* ------------------------------- consultas ------------------------------- */

  /**
   * Saldo de UM produto.
   *
   * Vai pela consulta livre com `PRO_CODIGO:igual` porque é essa forma que o
   * agrupador do outro lado reconhece: ele junta as consultas que chegam na
   * mesma janela e diferem só no valor de um filtro `igual` sobre coluna única.
   * A conferência da contagem pergunta item a item — é exatamente o caso.
   */
  async estoqueProduto(codProduto: number, empresa: number): Promise<any | null> {
    const linhas = await this.pedir(
      '/erp/produtos',
      {
        empresa,
        campos: 'PRO_CODIGO,ESTOQUE_DISPONIVEL,ESTOQUE_RESERVADO',
        f: `PRO_CODIGO:igual:${codProduto}`,
        limite: 1,
      },
      { checarTruncado: false },
    );
    return linhas[0] ?? null;
  }

  /**
   * Saldo de VÁRIOS produtos numa consulta só (`PRO_CODIGO:em:...`, teto de 500
   * valores por chamada). Quem sabe a lista inteira de antemão manda o lote —
   * consulta unitária em série é para quando os itens chegam um a um.
   */
  async estoqueProdutos(codigos: number[], empresa: number): Promise<any[]> {
    if (codigos.length === 0) return [];
    return this.pedir(
      '/erp/produtos',
      {
        empresa,
        campos: 'PRO_CODIGO,ESTOQUE_DISPONIVEL,ESTOQUE_RESERVADO',
        f: `PRO_CODIGO:em:${codigos.join(',')}`,
        limite: 500,
      },
      { checarTruncado: false },
    );
  }

  /**
   * Saídas de estoque do período, agrupadas por produto e dia.
   *
   * A definição de saída (tudo que não tem origem NFE/CNE) mora no catálogo, do
   * lado da API — é a mesma regra do relatório legado do ERP, num lugar só.
   *
   * Truncar aqui significaria montar a contagem sem parte dos produtos, então a
   * resposta cortada é tratada como falha e a chamada volta para o OPENQUERY.
   */
  async saidasPorPeriodo(dataIni: string, dataFim: string, empresa: number): Promise<any[]> {
    return this.pedir(
      '/erp/lanctos-estoque/saidas',
      { dataIni, dataFim, empresa },
      { exigirCompleto: true },
    );
  }

  /**
   * Produtos do cadastro por filtro — a busca da contagem avulsa.
   *
   * `somente_com_saldo` não vem daqui: é soma de duas colunas, e o catálogo
   * filtra coluna a coluna. Fica no consumidor, sobre um conjunto que os outros
   * filtros já reduziram.
   */
  async produtosPorFiltro(f: FiltroProdutos): Promise<any[]> {
    const filtros: string[] = [];
    if (f.cod_produto != null) filtros.push(`PRO_CODIGO:igual:${f.cod_produto}`);
    // IMPORTANTE: esta consulta pede campo de relação (marca.MAR_DESCRICAO), e o
    // agrupador do outro lado NÃO junta consultas com relação. Vários códigos
    // precisam ir num único `em` — N chamadas unitárias viram N consultas reais
    // no Firebird disputando o pool.
    if (f.cod_produtos?.length) filtros.push(`PRO_CODIGO:em:${f.cod_produtos.join(',')}`);
    if (f.marcas?.length) filtros.push(`MAR_CODIGO:em:${f.marcas.join(',')}`);
    else if (f.marca != null) filtros.push(`MAR_CODIGO:igual:${f.marca}`);
    if (f.subgrupos?.length) filtros.push(`SUBGRP_CODIGO:em:${f.subgrupos.join(',')}`);
    else if (f.subgrupo != null) filtros.push(`SUBGRP_CODIGO:igual:${f.subgrupo}`);
    if (f.grupos?.length) filtros.push(`grupo.GRP_CODIGO:em:${f.grupos.join(',')}`);
    else if (f.grupo != null) filtros.push(`grupo.GRP_CODIGO:igual:${f.grupo}`);
    if (f.descricao) filtros.push(`PRO_DESCRICAO:contem:${f.descricao}`);

    return this.pedir(
      '/erp/produtos',
      {
        empresa: f.empresa,
        campos:
          'PRO_CODIGO,PRO_DESCRICAO,marca.MAR_DESCRICAO,REF_FABRICANTE,REF_FORNECEDOR,' +
          'LOCALIZACAO,UNIDADE,APLICACOES,CODIGO_BARRAS,ESTOQUE_DISPONIVEL,ESTOQUE_RESERVADO',
        f: filtros,
        ordenar: 'LOCALIZACAO',
        // Teto da tabela no catálogo. Filtro largo demais estoura, e aí a lista
        // volta pelo OPENQUERY inteira: contagem com produto faltando é pior que
        // contagem lenta.
        limite: 5000,
      },
      { exigirCompleto: true },
    );
  }

  /* --------- tabelas de apoio dos filtros (cache de 5 min do outro lado) ---- */

  async grupos(empresa: number): Promise<any[]> {
    return this.pedir('/erp/produtos-grupos', {
      empresa,
      campos: 'GRP_CODIGO,GRP_DESCRICAO',
      ordenar: 'GRP_DESCRICAO',
      limite: 5000,
    });
  }

  async subgrupos(empresa: number, grupo?: number): Promise<any[]> {
    return this.pedir('/erp/produtos-subgrupos', {
      empresa,
      campos: 'SUBGRP_CODIGO,SUBGRP_DESCRICAO,GRP_CODIGO',
      f: grupo != null ? `GRP_CODIGO:igual:${grupo}` : undefined,
      ordenar: 'SUBGRP_DESCRICAO',
      limite: 5000,
    });
  }

  async marcas(empresa: number): Promise<any[]> {
    return this.pedir('/erp/marcas', {
      empresa,
      campos: 'MAR_CODIGO,MAR_DESCRICAO',
      ordenar: 'MAR_DESCRICAO',
      limite: 5000,
    });
  }
}
