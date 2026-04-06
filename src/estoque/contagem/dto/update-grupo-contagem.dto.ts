import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateGrupoContagemDto {
  @ApiPropertyOptional({
    description: 'Novo valor do piso para as contagens do grupo',
    example: 'PISO A'
  })
  @IsOptional()
  @IsString()
  piso?: string;

  @ApiPropertyOptional({
    description: 'ID do colaborador para a 1a contagem',
    example: 'cm0abc123'
  })
  @IsOptional()
  @IsString()
  contagem1UsuarioId?: string;

  @ApiPropertyOptional({
    description: 'ID do colaborador para a 2a contagem',
    example: 'cm0def456'
  })
  @IsOptional()
  @IsString()
  contagem2UsuarioId?: string;

  @ApiPropertyOptional({
    description: 'ID do colaborador para a 3a contagem',
    example: 'cm0ghi789'
  })
  @IsOptional()
  @IsString()
  contagem3UsuarioId?: string;
}