import { Module } from '@nestjs/common';
import { OpenQueryService } from '../../shared/database/openquery/openquery.service';
import { ConciliacaoController } from './conciliacao.controller';
import { ConciliacaoService } from './conciliacao.service';
import { ApiConciliacaoFonte } from './fontes/api.fonte';
import { OpenQueryConciliacaoFonte } from './fontes/openquery.fonte';

@Module({
  controllers: [ConciliacaoController],
  providers: [
    ConciliacaoService,
    ApiConciliacaoFonte,
    OpenQueryConciliacaoFonte,
    OpenQueryService,
  ],
})
export class ConciliacaoModule {}
