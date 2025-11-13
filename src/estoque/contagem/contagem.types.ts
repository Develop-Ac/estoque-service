export type EstoqueSaidaRow = {
  data: string;                // (YYYY-MM-DD na origem Firebird)
  COD_PRODUTO: number;
  DESC_PRODUTO: string;
  mar_descricao: string;
  ref_fabricante: string | null;
  ref_FORNECEDOR: string | null;
  LOCALIZACAO: string | null;
  unidade: string | null;
  APLICACOES: string | null;
  codigo_barras: string | null;
  QTDE_SAIDA: number;
  ESTOQUE: number | null;
  RESERVA: number | null;
};
