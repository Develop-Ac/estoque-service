import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpenQueryService } from '../../shared/database/openquery/openquery.service';
import { ConciliacaoController } from './conciliacao.controller';
import { ConciliacaoService } from './conciliacao.service';
import { ErpFirebirdClient } from './erp-firebird.client';
import { ApiConciliacaoFonte } from './fontes/api.fonte';
import { OpenQueryConciliacaoFonte } from './fontes/openquery.fonte';

@Module({
  imports: [ConfigModule],
  controllers: [ConciliacaoController],
  providers: [ConciliacaoService, ErpFirebirdClient, ApiConciliacaoFonte, OpenQueryConciliacaoFonte, OpenQueryService],
})
export class ConciliacaoModule {}
