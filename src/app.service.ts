import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private prisma: PrismaService) { }

  getHello(): string {
    return 'Hello World!';
  }

  async login(codigo: string, senha: string) {
    const usuario = await this.prisma.sis_usuarios.findUnique({
      where: { codigo },
    });

    if (!usuario) {
      throw new BadRequestException('Usuário não encontrado');
    }

    if (usuario.senha !== senha) {
      // throw new UnauthorizedException('Senha incorreta');
    }

    return {
      success: true,
      usuario_id: usuario.id,
      usuario: usuario.nome,
      codigo: usuario.codigo,
      setor: usuario.setor,
    };
  }
}
