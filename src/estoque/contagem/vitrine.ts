import { EstoqueSaidaRow } from './contagem.types';

/**
 * Regras da locação VITRINE — espelham `pertenceAoPiso("VITRINE")` do front
 * (ContagemView): a vitrine fixa ("VITRINE"), as posições "V<dígito>..." e a
 * Vitrine Móvel (prefixo "VM", ex.: VM202A01), contada pelo mesmo colaborador.
 */
export function locacaoEhVitrine(locacaoRaw: string | null | undefined): boolean {
  const loc = (locacaoRaw ?? '').toUpperCase().trim();
  if (!loc) return false;
  return loc === 'VITRINE' || /^V\d/.test(loc) || loc.startsWith('VM');
}

/** Mantém apenas as linhas cuja LOCALIZACAO pertence à vitrine. */
export function filtrarVitrine(rows: EstoqueSaidaRow[]): EstoqueSaidaRow[] {
  return (rows ?? []).filter((r) => locacaoEhVitrine(r.LOCALIZACAO));
}

const TZ_PADRAO = 'America/Sao_Paulo';

/** Data civil (YYYY-MM-DD) de um instante no fuso informado. */
export function dataCivil(instante: Date, timeZone = TZ_PADRAO): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instante);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * "Ontem" no fuso da empresa (YYYY-MM-DD). Calcula sobre a data CIVIL, não sobre
 * o instante UTC: às 23h de Brasília o UTC já virou o dia e "ontem" ficaria
 * errado por um dia.
 */
export function dataOntem(agora: Date = new Date(), timeZone = TZ_PADRAO): string {
  const hoje = dataCivil(agora, timeZone);
  const [y, m, d] = hoje.split('-').map(Number);
  const ontem = new Date(Date.UTC(y, m - 1, d - 1));
  return ontem.toISOString().slice(0, 10);
}
