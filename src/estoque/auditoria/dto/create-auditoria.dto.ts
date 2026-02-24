export class CreateAuditoriaDto {
    contagem_cuid: string;
    cod_produto: number;
    tipo_movimento: 'BAIXA' | 'INCLUSAO' | 'CORRETO';
    quantidade_movimento: number;
    observacao: string;
    usuario_id: string;
    diferenca_final?: number; // Opcional ou removido, pois agora é calculado
}
