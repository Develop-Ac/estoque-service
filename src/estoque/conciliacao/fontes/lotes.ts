/** Tamanho máximo de lista IN aceito pela api-firebird-service (MAX_LISTA). */
export const TAMANHO_LOTE = 500;

export function emLotes<T>(valores: T[], tamanho = TAMANHO_LOTE): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < valores.length; i += tamanho) lotes.push(valores.slice(i, i + tamanho));
  return lotes;
}

/** Executa os lotes em sequência e concatena o resultado. */
export async function porLotes<T, R>(valores: T[], fn: (lote: T[]) => Promise<R[]>): Promise<R[]> {
  const saida: R[] = [];
  for (const lote of emLotes(valores)) saida.push(...(await fn(lote)));
  return saida;
}

/**
 * O resultado passou do limite que a fonte devolve. Não é falha da fonte, é
 * filtro grande demais: não dispara o fallback, vira 400 para o usuário.
 */
export class LimiteExcedidoError extends Error {}
