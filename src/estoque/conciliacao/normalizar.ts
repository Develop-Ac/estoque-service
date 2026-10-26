// Normalização dos valores que chegam do ERP: as duas fontes devolvem tipos
// diferentes (BLOB como Buffer, datas como Date ou string, números como string).

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export function texto(v: unknown): string | null {
  if (v == null) return null;
  let s: string;
  if (Buffer.isBuffer(v)) s = v.toString('utf8');
  else if (typeof v === 'object' && Array.isArray((v as any).data))
    s = Buffer.from((v as any).data).toString('utf8');
  else s = String(v);
  s = s.replace(/\u0000/g, '').trim();
  return s.length ? s : null;
}

export function numero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numeroOuNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function dataIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date)
    return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  return DATE_RX.test(s.slice(0, 10)) ? s.slice(0, 10) : s;
}

/** Coluna TIME: "hh:mm:ss" (com CAST) ou 1970-01-01Thh:mm:ss (sem CAST, o driver devolve data). */
export function hora(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date)
    return isNaN(v.getTime()) ? null : v.toISOString().slice(11, 19);
  return /(\d{2}:\d{2}:\d{2})/.exec(String(v))?.[1] ?? null;
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
