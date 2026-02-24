import { Module } from '@nestjs/common';
import { AuditoriaService } from './auditoria.service';
import { AuditoriaController } from './auditoria.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { EstoqueSaidasModule } from '../contagem/contagem.module';

@Module({
    imports: [PrismaModule, EstoqueSaidasModule], // Importa ContagemModule se precisar de algo de lá, ou só Prisma
    controllers: [AuditoriaController],
    providers: [AuditoriaService],
})
export class AuditoriaModule { }
