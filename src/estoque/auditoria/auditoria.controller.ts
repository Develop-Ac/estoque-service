import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';
import { CreateAuditoriaDto } from './dto/create-auditoria.dto';

@Controller('auditoria')
export class AuditoriaController {
    constructor(private readonly service: AuditoriaService) { }

    @Get('pendentes')
    async getItensParaAuditoria(@Query('data') data: string, @Query('piso') piso?: string) {
        return this.service.getItensParaAuditoria(data, piso);
    }

    @Post()
    async saveAuditoria(@Body() dto: CreateAuditoriaDto) {
        return this.service.saveAuditoria(dto);
    }

    @Get('historico/:cod_produto')
    async getHistorico(@Param('cod_produto') codProduto: string) {
        return this.service.getHistorico(+codProduto);
    }
}
