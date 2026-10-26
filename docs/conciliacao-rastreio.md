# Rastreio da divergência de estoque entre empresas (drill-down da conciliação)

Documento de 2026-10-26. Levantamento feito com o Lucas em três rodadas; base de fatos levantada no ERP em 24/10/2026.

Tela filha da Conciliação de Estoque (`/estoque/conciliacao`): dado um produto cujo saldo difere entre a empresa 1 (fiscal) e a empresa 3 (gerencial, auditada), mostra o kardex das duas empresas lado a lado, dia a dia, e aponta **em que data e por qual lançamento a diferença nasceu**. Só leitura: nada grava no ERP nem no Postgres.

Repositórios: `erp-firebird-api` (branch `deploy`), `estoque-service` (branch `Deploy`), `cotacao-frontend` (branch `Deploy`).

---

## 1. Decisões fechadas

| # | Decisão |
|---|---|
| Entrada | Botão **Rastrear** na linha da conciliação e campo de código na própria página. Rota `/estoque/conciliacao/[codigo]`. Permissão herdada de `/estoque/conciliacao` (detalhe dinâmico herda da tela-pai); sem SQL de permissão novo. |
| Saldo | A curva de cada empresa parte do saldo atual do cadastro (**disponível + reservado**) e anda **para trás** pelos lançamentos do período. Além disso, a soma de todo o kardex (E − S desde o início) é comparada com o saldo do cadastro; se não bater, aviso "cadastro ≠ kardex na empresa X" (é um terceiro tipo de problema). |
| Período | Padrão: 12 meses até hoje. Botão "ampliar para tudo" (desde o primeiro lançamento). |
| Reservas | A curva usa **todos** os lançamentos (todos os `TIPO_ESTOQUE`), para fechar com a diferença que a conciliação mostrou (disp + res). Os pares de reserva/remessa se anulam e aparecem recolhidos dentro do dia. |
| Casamento | Lançamento físico da empresa 3 procura par na empresa 1 (e vice-versa): **mesma quantidade, mesmo sentido (E/S), mesma classe de origem**, dentro de uma **janela de 30 dias** para qualquer lado. Preferência: mesmo dia, depois menor atraso, depois mesmo usuário (desempate, nunca exigência). Mesmo dia = normal; outro dia = **espelho atrasado** (amarelo); sem par = **sem espelho** (vermelho). |
| Cancelamentos | CNS/ENS/CNE casam com o documento cancelado **na mesma empresa** pelo número (NFS/NFE); se não houver número, com um lançamento da classe oposta de mesma quantidade no mesmo dia. Os dois saem do casamento entre empresas. |
| Ajustes locais | CDE, LIA, CAD, EFD, CDP nunca têm par: viram degrau **"ajuste só na empresa X"**, explicado, não suspeito. |
| Resumo | Afirma. Lista os degraus persistentes em ordem cronológica, com data, documento, usuário, máquina e efeito. Se não houver degrau persistente no período e a diferença for ≠ 0: "constante desde DD/MM/AAAA (início do período): nasceu antes, conferir entrada ou cadastro; amplie o período". Degraus temporários (atraso que se corrigiu) ficam em lista à parte, recolhida. |
| Gráfico | Linha da diferença E3 − E1 ao longo do tempo (chart.js, já usado no front). Clicar num ponto rola a tabela até o dia. |
| Tabela | Uma linha por **dia** em que alguma empresa teve movimento. Empresa 1 à esquerda, empresa 3 à direita, diferença acumulada no meio; a célula da diferença muda de cor no dia do degrau. Toggle "só dias de degrau". Começa completa. |
| Saídas | **Copiar resumo** (texto para WhatsApp, sem link). **Excel** (aba Resumo + aba Lado a lado). **PDF** pela rota de impressão `app/(print)/conciliacao-rastreio/[codigo]` (mesmo padrão do relatório de comissões): resumo, gráfico e tabela. |
| Fonte | Principal `erp-firebird-api`; qualquer falha refaz a requisição inteira por OPENQUERY (mesma regra e mesmo `comFonte` da conciliação). Resposta traz `fonte`. |
| Catálogo da api | `lanctos-estoque` ganha as colunas HORA_SERVIDOR, USU_CODIGO, MAQUINA, TIPO_ESTOQUE, NFS_ITEM, NFE_ITEM, CONTAGEM_ESTOQUE. |

---

## 2. Fatos do ERP (levantados em 24/10/2026)

**`LANCTOS_ESTOQUE`** (kardex), uma sequência de `LANCTO` por `EMPRESA`. Colunas que importam: `LANCTO`, `DATA`, `HORA_SERVIDOR` (TIME; o driver devolve `1970-01-01Thh:mm:ss`, só a hora vale), `PRO_CODIGO`, `ORIGEM` (CHAR 3), `OPERACAO` ('E'/'S'), `TIPO_ESTOQUE` (0 = físico/disponível; 1 condicional, 2 OS, 3 pré-venda, 4 fora do estabelecimento, 5 conserto), `QUANTIDADE` (4 casas), `NFS`, `NFS_ITEM`, `NFE`, `NFE_ITEM`, `CONDICIONAL`, `ORDEM_SERVICO`, `CONTAGEM_ESTOQUE` (preenchida em todo CDE), `USU_CODIGO`, `MAQUINA` (VARCHAR 15).

- Σ(E − S) de todos os lançamentos = `ESTOQUE_DISPONIVEL + ESTOQUE_RESERVADO` de `PRODUTOS` (identidade válida em 99,93% dos produtos; conferida no produto 32441 nas duas empresas).
- Empresa 1 começa em 31/12/2012 (carga inicial). Empresa 3 tem histórico desde 2005, 42 lançamentos com data 1899 e um com data futura: a leitura "tudo" precisa tolerar isso (ordenar por DATA, LANCTO; datas < 2000 e > hoje entram na soma, mas o gráfico começa no primeiro dia plausível).
- O espelho entre empresas existe, mas **atrasa** (1 a 5 dias no exemplo) e às vezes **não acontece** (vendas no CAIXA da empresa 3 sem lançamento na 1). Numeração de NFS/NFE é própria de cada empresa; usuário e máquina costumam ser iguais nos dois lados.
- Cancelamento + relançamento no mesmo dia é comum (NFE cancelada e lançada de novo; NFS cancelada e substituída).
- CDE na empresa 1 é concentrado nos fechamentos de trimestre (31/03/2026: 8.430 saídas, 52 mil unidades; 30/06/2026) na máquina ACRH01, usuário 159. Na empresa 3 é contínuo e pequeno (GERENTE-VENDAS, GERENCIA01, AC-AUDITORIA01…).

**Dicionário de `ORIGEM`** (do Celta) e classe para o casamento:

| Classe | Origens | Rótulo |
|---|---|---|
| `saida` (física) | NFS Nota fiscal de saída · EVF Entrega de venda futura · VEF Venda fora do estabelecimento · DEF Devolução a fornecedor | procura par |
| `entrada` (física) | NFE Nota fiscal de compra · NEN Nota de entrada de emissão própria · DEV Devolução de cliente | procura par |
| `cancelamento` | CNS Cancelamento de nota de venda · ENS Estorno de nota de venda · CNE Cancelamento de nota de compra | compensa o documento na mesma empresa |
| `reserva` | CON Condicional · OSV Ordem de serviço · PRE Pré-venda · RMF Remessa p/ venda fora · REF Retorno de remessa fora · RMC Remessa p/ conserto · RRC Retorno de conserto | pares se anulam, fora do casamento |
| `ajuste` | CDE Contagem de estoque · LIA Lançamento individual de ajuste · CAD Lançamento direto pelo cadastro · EFD Ajuste do SPED Fiscal · CDP Controle de produção | degrau explicado, sem par |

Origem fora do dicionário: classe `outro`, rótulo = o código cru com "?"; entra na curva, não entra no casamento, vira degrau "não classificado".

---

## 3. erp-firebird-api (branch `deploy`)

`src/erp/movimento/tabelas/` → tabela `LANCTOS_ESTOQUE` (`lanctos-estoque`): acrescentar as colunas `HORA_SERVIDOR` (texto; `expr: 'CAST({a}.HORA_SERVIDOR AS VARCHAR(8))'` para vir como "hh:mm:ss"), `USU_CODIGO` (inteiro), `MAQUINA` (texto, TRIM), `TIPO_ESTOQUE` (inteiro), `NFS_ITEM` (inteiro), `NFE_ITEM` (inteiro), `CONTAGEM_ESTOQUE` (inteiro). Descrições curtas; no `TIPO_ESTOQUE`, a armadilha de que Σ(E−S) só bate com disp + res somando todos os tipos. Consumidor novo: `estoque-service` (rastreio da conciliação). Regenerar só `docs/tabelas/lanctos-estoque.md` (não rodar `npm run docs` inteiro). `npm run teste` passa.

---

## 4. estoque-service (branch `Deploy`)

Dentro do módulo existente `src/estoque/conciliacao/`.

### 4.1 Fonte (`ConciliacaoFonte`, as duas implementações)

Métodos novos:

- `kardex(empresa, codigo, data_inicial?, data_final?)` → lançamentos do produto na empresa, ordenados por `DATA, LANCTO`. Sem período = tudo. API: `POST /erp/lanctos-estoque/consulta` com `empresa`, filtros `PRO_CODIGO igual`, `DATA entre` (quando houver), campos LANCTO, DATA, HORA_SERVIDOR, ORIGEM, OPERACAO, TIPO_ESTOQUE, QUANTIDADE, NFS, NFS_ITEM, NFE, NFE_ITEM, CONDICIONAL, ORDEM_SERVICO, CONTAGEM_ESTOQUE, USU_CODIGO, MAQUINA; `ordenar` DATA, LANCTO; `limite` 50000; `meta.truncado` → `LimiteExcedidoError` (400). OPENQUERY: `SELECT FIRST 50001 … FROM LANCTOS_ESTOQUE L WHERE L.EMPRESA = 3 AND L.PRO_CODIGO = 32441 [AND L.DATA BETWEEN '…' AND '…'] ORDER BY L.DATA, L.LANCTO`, com `CAST(L.HORA_SERVIDOR AS VARCHAR(8)) AS HORA_SERVIDOR`.
- `totaisKardex(empresa, codigo)` → `{ entradas, saidas }` somando o kardex inteiro. API: `agrupar: ['OPERACAO']`, `agregar: [{ fn: 'somar', campo: 'QUANTIDADE', como: 'TOTAL' }]`, filtro `PRO_CODIGO igual`. OPENQUERY: `SELECT OPERACAO, SUM(QUANTIDADE) AS TOTAL … GROUP BY OPERACAO`.
- `produtoNasDuasEmpresas(codigo)` → cadastro (empresa 3: PRO_DESCRICAO, REF_FABRICANTE, UNIDADE, LOCALIZACAO, APLICACOES, marca, grupo/subgrupo) e saldos das duas empresas. Reaproveitar `produtosGerencial({codigos:[c]})` e `saldosFiscal([c])`.

Só valores inteiros e datas `YYYY-MM-DD` entram inline no OPENQUERY (mesma regra da conciliação).

### 4.2 Regras de cálculo (`rastreio.ts`, função pura, testável)

Entrada: lançamentos das duas empresas, saldos atuais (disp, res) das duas, período. Saída: o JSON da seção 4.3.

1. **Normalizar** cada lançamento: data `YYYY-MM-DD`, hora `hh:mm:ss`, quantidade número, origem TRIM maiúscula, `classe` e `rotulo` pelo dicionário da seção 2, `delta = OPERACAO === 'E' ? Q : -Q`.
2. **Curva por dia**: agrupar por data. `saldo_fim(último dia) = disp + res` da empresa; andando para trás, `saldo_fim(dia anterior) = saldo_fim(dia) − Σ delta(dia)`. Entre dias sem movimento o saldo se mantém. `saldo_inicio_periodo` = saldo antes do primeiro dia do período. Diferença acumulada do dia = `saldo_fim E3 − saldo_fim E1`. Curva usa todos os lançamentos.
3. **Cancelamentos**: para cada lançamento de classe `cancelamento`, procurar na mesma empresa o lançamento da classe oposta (`saida` para CNS/ENS, `entrada` para CNE) com o mesmo NFS/NFE; se não houver, mesma quantidade no mesmo dia. Marcar os dois `status: 'cancelado'` e tirá-los do casamento.
4. **Reservas**: todo lançamento de classe `reserva` recebe `status: 'reserva'`, fora do casamento.
5. **Casamento** (como validado nas fixtures reais): lançamentos físicos (`saida`/`entrada`, não cancelados) das duas empresas, chave = classe + sentido + quantidade. **Por nível de atraso**: primeiro todos os pares do mesmo dia, depois os de 1 dia, e assim até 30 dias (a regra lançamento a lançamento empurrava o "sem espelho" para semanas depois: no 32441 a NFS 436814 aparecia como a 440967 de 22/05/2023). Par encontrado: os dois recebem `par: { empresa, lancto, atraso_dias }` e `status: 'normal'` (atraso 0) ou `'atrasado'`. **Segunda passada**, para o que sobrou: mesma chave, **sem limite de dias** dentro do período carregado, mas exigindo **mesmo `USU_CODIGO` e mesma `MAQUINA`** (sem essa exigência ela juntava eventos sem relação: a 520207 do 32441 com uma venda 97 dias depois, a EVF do 26914 com uma de 824 dias). É o que resolve a devolução do 50311, espelhada 61 dias depois pelo mesmo usuário na mesma máquina. Sem par depois das duas passadas: `status: 'sem_espelho'`. O service lê o kardex desde o início do período **menos 30 dias**, sem limite por cima, porque o espelho de um lançamento do começo do período pode estar antes dele. Classe `ajuste`: `status: 'ajuste'`. Classe `outro`: `status: 'nao_classificado'`.
6. **Degraus**: dia em que a diferença acumulada mudou em relação ao dia anterior, **ou** em que a soma dos efeitos persistentes do dia é ≠ 0 mesmo com a diferença parada (no 26914, em 17/05/2021 uma compra só na empresa 1 coincidiu com a volta de um espelho atrasado; sem essa regra a compra ficava escondida e a lista de degraus não fechava com a diferença). Cancelamento em dia diferente da nota, só numa empresa, gera degrau temporário; cancelamento cujo documento não está no kardex lido fica `sem_espelho`. Para cada degrau, `delta = diferença(dia) − diferença(dia anterior)`, decomposto nos lançamentos do dia com status `sem_espelho`, `ajuste`, `atrasado` e `nao_classificado` (sinal: lançamento na empresa 3 soma `delta` do lançamento; na empresa 1 soma `−delta`). Se a soma explicada ≠ `delta` do dia, acrescentar `{ tipo: 'nao_explicado', valor: residual }`.
   - **Persistente**: `sem_espelho`, `ajuste`, `nao_classificado`, `nao_explicado`.
   - **Temporário**: `atrasado` (o par do outro lado compensa noutro dia). Os dois dias do atraso entram na lista `temporarios`.
7. **Resumo**: `constante = degraus persistentes vazios && diferença_atual ≠ 0`. `constante_desde = data_inicial do período` (ou primeiro dia com movimento, no modo "tudo"). Texto do resumo montado no backend (campo `resumo_texto`, pronto para copiar) e também os dados estruturados para a tela.
8. **Kardex × cadastro** por empresa: `kardex_bate = |(entradas − saidas) − (disp + res)| < 0,0005`; se não bater, aviso com os dois números.
9. Arredondar quantidades e diferenças em 3 casas.

### 4.3 Rota

`GET /estoque/conciliacao/rastreio/:codigo?data_inicial=&data_final=&tudo=1`

- `codigo` inteiro obrigatório. Sem datas: `data_final = hoje`, `data_inicial = hoje − 12 meses`. `tudo=1` ignora as datas. Validar: final ≥ inicial; código inteiro; produto inexistente na empresa 3 → 404.
- Resposta:

```jsonc
{
  "fonte": "api" | "openquery",
  "produto": { "PRO_CODIGO", "PRO_DESCRICAO", "REF_FABRICANTE", "MARCA", "UNIDADE", "GRP_DESCRICAO", "SUBGRP_DESCRICAO", "LOCALIZACOES": [] },
  "periodo": { "data_inicial", "data_final", "tudo": false },
  "empresas": {
    "1": { "disponivel", "reservado", "saldo", "kardex_entradas", "kardex_saidas", "kardex_bate": true, "lancamentos": 86, "saldo_inicio_periodo" },
    "3": { ...igual }
  },
  "diferenca_atual": 3,            // E3 − E1 em disp + res (mesma da conciliação)
  "diferenca_inicio_periodo": 0,
  "dias": [
    {
      "data": "2025-03-21",
      "e1": { "lancamentos": [Lancamento], "saldo_fim": 5 },
      "e3": { "lancamentos": [Lancamento], "saldo_fim": 1 },
      "diferenca_fim": -4,
      "degrau": null | { "delta": -1, "persistente": true }
    }
  ],
  "degraus": [                      // persistentes, em ordem
    { "data": "2025-03-21", "delta": -1, "tipo": "sem_espelho" | "ajuste" | "nao_classificado" | "nao_explicado",
      "empresa": 3, "lancto": 9876543, "origem": "NFS", "rotulo": "Nota fiscal de saída", "documento": 520207,
      "quantidade": 1, "usuario": 6, "maquina": "CAIXA", "descricao": "venda NFS 520207 (CAIXA, usuário 6) só na empresa 3 · −1" }
  ],
  "temporarios": [ { "data_ida": "2021-07-08", "data_volta": "2021-07-12", "atraso_dias": 4, "descricao": "..." } ],
  "constante": false,
  "constante_desde": null,
  "resumo_texto": "32441 GRADE HILUX 09/ CINZA C/ FRISO CROMADO\nEmpresa 1: 5 (disp 5 + res 0) · Empresa 3: 2 (disp 2 + res 0) · Diferença E3−E1: −3\n\n14/04/2023 · venda NFS 436814 (CAIXA, usuário 81) só na empresa 3 · −1\n...",
  "avisos": []
}
```

`Lancamento`: `{ lancto, data, hora, origem, rotulo, classe, operacao, tipo_estoque, quantidade, delta, documento, documento_tipo: 'NFS'|'NFE'|'CONDICIONAL'|'OS'|'CONTAGEM'|null, usuario, maquina, status, par: { empresa, lancto, atraso_dias } | null }`.

### 4.4 Testes (`rastreio.spec.ts`, função pura, sem fonte)

- Curva: saldo para trás a partir de disp + res; dia sem movimento mantém; `saldo_inicio_periodo` correto.
- Casamento: mesmo dia → normal; 4 dias depois → atrasado dos dois lados, degrau temporário; sem par → `sem_espelho`, degrau persistente com o sinal certo (venda só na 3 → delta −1; entrada só na 1 → delta −1; venda só na 1 → +1).
- Cancelamento: NFS + CNS com o mesmo número saem do casamento; NFE cancelada e relançada no mesmo dia casa só uma vez.
- Reserva: CON S/E não gera degrau e não entra no casamento.
- Ajuste: CDE só na empresa 1 → degrau `ajuste`, empresa 1.
- Constante: diferença 2 sem degrau → `constante`, `constante_desde` = início.
- Kardex × cadastro: aviso quando não bate.
- Caso real: fixture do produto 32441 (`docs/fixtures/rastreio-32441.json`, exportado do levantamento) → 4 `sem_espelho` (NFS 436814, 470849, 513615, 520207) e diferença −3.

Rota: validação do período e 404 de produto inexistente (controller, com service mockado).

---

## 5. cotacao-frontend (branch `Deploy`)

Kit `components/ui` e `DESIGN.md`, como a tela-mãe.

**5.1 `lib/conciliacao.service.ts`**: tipos do JSON acima e `rastreio(codigo, { data_inicial, data_final, tudo })`.

**5.2 `lib/conciliacao.rastreio.ts`** (puro): `linhasDaTabela(resposta, soDegraus)`, `serieGrafico(resposta)` (uma amostra por dia da `dias`, mais os pontos de início e fim do período), `textoExcel(resposta)` (linhas das duas abas) e `rotuloStatus(status)`.

**5.3 Tela-mãe** (`app/(private)/estoque/conciliacao/page.tsx`): coluna de ação com botão secundário "Rastrear" em cada linha → `router.push('/estoque/conciliacao/<codigo>')`. Nada mais muda.

**5.4 `app/(private)/estoque/conciliacao/[codigo]/page.tsx`**:
- PageHeader "Rastreio da divergência", subtítulo com código e descrição; link "voltar à conciliação".
- Barra: campo de código (Enter navega), 2 AnimatedDatePicker (padrão 12 meses), toggle "Tudo", botão primário **Rastrear**; secundários **Copiar resumo**, **Excel**, **PDF**.
- Cards de saldo: Empresa 1 (disp, res, saldo, kardex bate?), Empresa 3 (idem), Diferença atual (Badge crit quando ≠ 0).
- Card **Resumo**: texto afirmativo; lista de degraus persistentes (data, descrição, delta com Badge); quando `constante`, caixa warning com o texto e botão "ampliar para tudo". Temporários em `<details>` recolhido. Avisos em caixa warning.
- Gráfico: linha da `diferenca_fim` por dia (react-chartjs-2, já instalado), clique no ponto → `scrollIntoView` da linha do dia.
- Tabela por dia: colunas Data | Empresa 1 (lançamentos: hora, rótulo da origem, documento, qtd com sinal, usuário/máquina, Badge de status) | Saldo E1 | **Diferença** | Saldo E3 | Empresa 3 (idem). Reservas recolhidas em "n reservas" com `<details>`. Linha de degrau com a célula Diferença em `crit` (persistente) ou `warn` (temporário). Checkbox "Só dias de degrau". Rodapé "Fonte dos dados: api/openquery".
- Copiar resumo: `navigator.clipboard.writeText(resumo_texto)` com toast.
- Excel: xlsx com aba "Resumo" (produto, saldos, diferença, degraus) e aba "Lado a lado" (uma linha por lançamento: data, empresa, hora, origem, rótulo, documento, quantidade, usuário, máquina, status, atraso, saldo E1, saldo E3, diferença).
- PDF: `window.open('/conciliacao-rastreio/<codigo>?data_inicial=&data_final=&tudo=')`.

**5.5 `app/(print)/conciliacao-rastreio/[codigo]/page.tsx`**: mesmo padrão de `app/(print)/comissoes-relatorio` (busca os dados, renderiza resumo + gráfico + tabela em leiaute de impressão, `window.print()` ao carregar). Sem reservas, sem toggles.

**5.6 Testes**
- `__tests__/estoque/conciliacao/rastreio.test.ts`: `linhasDaTabela` com toggle, `serieGrafico`, `textoExcel` (contagem de linhas e colunas).
- `__tests__/estoque/conciliacao/rastreio-page.test.tsx`: render com fetch mockado (fixture do 32441 reduzida), resumo com os 4 degraus, toggle "só dias de degrau" reduz as linhas, botão Copiar chama o clipboard com `resumo_texto`.

---

## 6. Ordem de entrega

1. `erp-firebird-api`: colunas novas em `lanctos-estoque` → deploy.
2. `estoque-service`: fonte + `rastreio.ts` + rota → deploy.
3. `cotacao-frontend`: tela, rota de impressão, botão na tela-mãe → deploy.

Sem SQL: a sub-rota herda a permissão de `/estoque/conciliacao`.

## 7. Homologação

| Caso | Produto | O que a tela tem de dizer |
|---|---|---|
| Sem espelho | 32441 GRADE HILUX 09/ CINZA C/ FRISO CROMADO (E1 5, E3 2) | Com tudo, 7 degraus persistentes que somam −3: 09/05/2022 NFS 398197 só na 3 (−1) e 07/11/2022 DEV NFS 417872 só na 3 (+1, anula a anterior); NFS 436814 (14/04/2023), 470849 (30/01/2024), 513615 (23/01/2025) e 520207 (21/03/2025) só na 3 (−1 cada); 26/06/2025 NFS 441438 só na 1 (+1: a 441423 foi cancelada e reemitida, e a reemissão ficou sem par). Atrasos de 1 a 5 dias como temporários. Com 12 meses: "constante desde 26/10/2025", nenhum degrau. A leitura manual do levantamento (4 vendas) estava incompleta: 4 × (−1) não fecharia −3. |
| Ajuste de contagem | 46665 LIMPA AR CONDICIONADO SPAIN 200ML/140G (E1 3, E3 4) | diferença 0 nos 12 meses até 14/10/2026; nesse dia um único degrau `ajuste` na empresa 3: CDE +1, LANCTO 13584740, usuário 19, máquina GERENCIA01. Em 17/10 a NFS 581757 cancelada (CNS) e reemitida como 581760 não gera degrau. Diferença +1. |
| Ajuste na empresa 1 + atraso longo | 50311 LAN T HILUX 2021/ LE DUPLA LED (E1 3, E3 2) | degrau `ajuste` na empresa 1 em 30/06/2026 (CDE +1, LANCTO 1324734, usuário 159, ACRH01). Devolução DEV de 06/08/2026 na empresa 3 (NFS 573939) espelhada na 1 só em 06/10/2026 (NFS 486677): tem de aparecer como **temporário** de 61 dias (segunda passada), não como dois "sem espelho". Diferença −1. |
| Constante | 26914 P/BRISA MB SPRINTER 12/19 DEGR (E1 5, E3 4) | 12 meses: 4 lançamentos em cada empresa, todos no mesmo dia; "constante desde …", zero degraus. Ampliando para tudo: 3 degraus que somam −1: 21/01/2021 NFS 283416 só na empresa 1 (+1); 17/05/2021 NFE 18831 só na empresa 1 (−1, escondida por um espelho atrasado que voltou no mesmo dia); 25/04/2023 venda EVF NFS 438002 (usuário 40, máquina AC-AT-04) só na empresa 3 (−1). Em 22/04/2023 a NFE 25480 cancelada e relançada na empresa 1 não gera degrau. |
| Kardex ≠ cadastro | 293 | a soma do kardex da empresa 3 dá 5 e o cadastro diz 4: a tela tem de mostrar o aviso "cadastro ≠ kardex na empresa 3". |

Fixtures reais dos quatro produtos em `docs/fixtures/rastreio-<codigo>.json` (exportadas do ERP em 24 e 26/10/2026) alimentam os testes de `rastreio.spec.ts`. Diferença nas tabelas acima é E3 − E1.

Mais: derrubar `ERP_API_URL` e repetir o 32441 → mesmo resultado com "Fonte: openquery".
