# estoque-service

API NestJS + Prisma (Postgres) do módulo de estoque da intranet da AC Acessórios:
contagem de estoque (app contagem, locação `A1403A03`, avulsa com pendentes,
início/fim como KPI) e auditoria (rastreio do produto pelo kardex do ERP).
Controllers em `src/estoque/{contagem,auditoria}`. DDL manual em `sql/`.

Regras que valem aqui: nunca rodar migrations, entregar SQL para aplicação manual.
Nunca comitar; o commit é do usuário. Firebird: sempre filtrar EMPRESA.

## Agent skills

### Issue tracker

Trello, quadros Sprint Back Log e Sprint (cartão `Módulo: descrição`). See `docs/agents/issue-tracker.md`.

### Triage labels

Listas do Trello carregam o estado; só `needs-info` e `ready-for-agent` são etiquetas. See `docs/agents/triage-labels.md`.

### Domain docs

single-context: `CONTEXT.md` na raiz e ADRs em `docs/adr/`. See `docs/agents/domain.md`.
