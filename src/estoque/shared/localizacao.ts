// Função auxiliar para extrair e validar locações
export function formatAndValidateLocation(text: string | null): string | null {
  if (!text) return null;

  const upperApp = text.toUpperCase();

  // 1. Regras Especiais (Prioridade Alta)
  // BOX (ex: BOX 03, BOX 3, BOX BEBEDOR, BOX 1 CX 4, BOX2A02, BOX3B01)
  // Aceita digitos (com sub-locação opcional tipo A02, B01) OU a palavra especifica BEBEDOR
  const boxMatch = upperApp.match(
    /\bBOX\s*(?:BEBEDOR|\d+(?:[A-Z]\d+)?(?:\s+CX\s+\d+)?)\b/i,
  );
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
