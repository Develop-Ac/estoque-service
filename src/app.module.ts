import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { S3Module } from './storage/s3.module';
import { EstoqueSaidasModule } from './estoque/contagem/contagem.module';
import { AuditoriaModule } from './estoque/auditoria/auditoria.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Torna o módulo disponível globalmente
    }),
    PrismaModule,
    S3Module,
    S3Module,
    EstoqueSaidasModule,
    AuditoriaModule,

    // ⬇️ Prefixa *somente* esses módulos com /compras
    RouterModule.register([
      { path: 'estoque', module: EstoqueSaidasModule },
    ]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
