import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';
import { CreateAuditoriaDto } from './dto/create-auditoria.dto';

@Controller('auditoria')
export class AuditoriaController {
    constructor(private readonly service: AuditoriaService) { }

    @Get('pendentes')
    async getItensParaAuditoria(@Query('data') data: string, @Query('piso') piso?: string) {
        return this.service.getItensParaAuditoria(data, piso);
    }

    /** Contagens avulsas para o seletor da auditoria (com resumo de divergências/pendências). */
    @Get('avulsas')
    async listarAvulsas() {
        return this.service.listarAvulsasParaAuditoria();
    }

    /** Auditoria de uma contagem avulsa específica, consolidando as sessões vinculadas. */
    @Get('pendentes-avulsa')
    async getItensParaAuditoriaAvulsa(@Query('cuid') cuid: string) {
        return this.service.getItensParaAuditoriaAvulsa(cuid);
    }

    @Post()
    async saveAuditoria(
        @Body() dto: CreateAuditoriaDto,
        @Headers('x-user-id') userIdHeader?: string,
    ) {
        return this.service.saveAuditoria(dto, userIdHeader);
    }

    @Get('historico/:cod_produto')
    async getHistorico(@Param('cod_produto') codProduto: string) {
        return this.service.getHistorico(+codProduto);
    }
}
