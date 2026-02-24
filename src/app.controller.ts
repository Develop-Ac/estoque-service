import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { AppService } from './app.service';

@ApiTags('Sistema')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Post('login')
  @ApiOperation({
    summary: 'Login do usuário',
    description: 'Autentica o usuário e retorna seus dados'
  })
  async login(@Body() body: { codigo: string; senha: string }) {
    return this.appService.login(body.codigo, body.senha);
  }

  @Get()
  @ApiOperation({
    summary: 'Health check da API',
    description: 'Endpoint para verificar se a API está funcionando corretamente'
  })
  @ApiOkResponse({
    description: 'API está funcionando',
    example: 'Hello World!'
  })
  getHello(): string {
    return this.appService.getHello();
  }
}
