import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { S3Module } from './storage/s3.module';
import { EstoqueSaidasModule } from './estoque/contagem/contagem.module';

@Module({
imports: [
    PrismaModule,
    S3Module,
    EstoqueSaidasModule,

    // ⬇️ Prefixa *somente* esses módulos com /compras
    RouterModule.register([
      { path: 'estoque', module: EstoqueSaidasModule },
    ]),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
