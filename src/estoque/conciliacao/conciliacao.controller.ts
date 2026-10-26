import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ConciliacaoService,
  ConciliarBody,
  lerCodigo,
  lerInteiros,
  lerOperacoes,
  lerPeriodo,
  lerPeriodoRastreio,
} from './conciliacao.service';

@ApiTags('Estoque - Conciliação')
@Controller('conciliacao')
export class ConciliacaoController {
  constructor(private readonly service: ConciliacaoService) {}

  @Get('grupos')
  @ApiOperation({ summary: 'Grupos de produto da empresa 3' })
  grupos() {
    return this.service.grupos();
  }

  @Get('subgrupos')
  @ApiOperation({
    summary: 'Subgrupos da empresa 3, opcionalmente só dos grupos informados',
  })
  @ApiQuery({ name: 'grupos', required: false, example: '10,12' })
  subgrupos(@Query('grupos') grupos?: string) {
    return this.service.subgrupos(lerInteiros(grupos, 'grupos'));
  }

  @Get('operacoes')
  @ApiOperation({ summary: 'Operações fiscais de saída ativas da empresa 3' })
  operacoes() {
    return this.service.operacoes();
  }

  @Get('vendas')
  @ApiOperation({
    summary: 'Valida NFS digitados (existência, status e cancelamento)',
  })
  @ApiQuery({ name: 'nfs', required: true, example: '10231,10232' })
  vendas(@Query('nfs') nfs?: string) {
    return this.service.validarVendas(lerInteiros(nfs, 'nfs'));
  }

  @Get('notas')
  @ApiOperation({
    summary:
      'Notas de saída da empresa 3 por operação e período (até 90 dias), sem canceladas',
  })
  @ApiQuery({ name: 'data_inicial', required: true, example: '2026-10-01' })
  @ApiQuery({ name: 'data_final', required: true, example: '2026-10-31' })
  @ApiQuery({ name: 'operacoes', required: true, example: '1,104' })
  notas(
    @Query('data_inicial') dataInicial?: string,
    @Query('data_final') dataFinal?: string,
    @Query('operacoes') operacoes?: string,
  ) {
    return this.service.notas({
      ...lerPeriodo(dataInicial, dataFinal),
      operacoes: lerOperacoes(operacoes),
    });
  }

  @Post('conciliar')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Concilia o estoque da empresa 1 (fiscal) com a empresa 3 (gerencial)',
    description:
      'modo=grupo usa grupos/subgrupos; modo=venda e modo=operacao usam a lista de NFS da empresa 3 e trazem a quantidade movimentada.',
  })
  @ApiBody({
    schema: {
      example: { modo: 'venda', nfs: [10231, 10232] },
    },
  })
  conciliar(@Body() body: ConciliarBody) {
    return this.service.conciliar(body);
  }

  @Get('rastreio/:codigo')
  @ApiOperation({
    summary:
      'Rastreio da divergência E3 − E1 de um produto: kardex lado a lado por dia e onde a diferença nasceu',
    description:
      'Sem datas: últimos 12 meses até hoje. tudo=1 lê o kardex inteiro (ignora as datas).',
  })
  @ApiParam({ name: 'codigo', example: 32441 })
  @ApiQuery({ name: 'data_inicial', required: false, example: '2025-10-26' })
  @ApiQuery({ name: 'data_final', required: false, example: '2026-10-26' })
  @ApiQuery({ name: 'tudo', required: false, example: '1' })
  rastreio(
    @Param('codigo') codigo: string,
    @Query('data_inicial') dataInicial?: string,
    @Query('data_final') dataFinal?: string,
    @Query('tudo') tudo?: string,
  ) {
    return this.service.rastreio(
      lerCodigo(codigo),
      lerPeriodoRastreio(dataInicial, dataFinal, tudo),
    );
  }
}
