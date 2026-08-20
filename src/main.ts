// src/main.ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import fastifyHelmet from '@fastify/helmet';
import fastifyCookie from '@fastify/cookie';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

const BODY_LIMIT = 25 * 1024 * 1024; // 25mb

function parseOrigins(env?: string): (string | RegExp)[] {
  if (!env) return [];
  return env
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      // Permite regex usando prefixo "regex:"
      if (s.startsWith('regex:')) {
        const pattern = s.slice(6);
        return new RegExp(pattern);
      }
      return s;
    });
}

function isAllowedOrigin(origin: string | undefined, allowed: (string | RegExp)[]) {
  if (!origin) return true; // requests server-to-server, curl, etc.
  if (allowed.length === 0) return true; // se não configurou nada, libera
  for (const rule of allowed) {
    if (rule instanceof RegExp && rule.test(origin)) return true;
    if (typeof rule === 'string' && rule === origin) return true;
  }
  return false;
}

// Reproduz o mount-path do Express: app.use(['/docs', '/docs-json'], ...)
function isDocsPath(url: string): boolean {
  const path = url.split('?')[0];
  return (
    path === '/docs' ||
    path.startsWith('/docs/') ||
    path === '/docs-json' ||
    path.startsWith('/docs-json/')
  );
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: BODY_LIMIT,
      // Express trata /rota e /rota/ como a mesma coisa; o Fastify não trata por padrão.
      ignoreTrailingSlash: true,
    }),
    { bufferLogs: true },
  );

  // Se estiver atrás de proxy reverso (Nginx/Traefik) e usar cookies Secure, habilite
  // trustProxy: true nas opções do FastifyAdapter acima.

  await app.register(fastifyCookie);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,     // necessário para swagger-ui
    crossOriginEmbedderPolicy: false, // evita bloqueio de assets
  });

  // Substitui bodyParser.json/urlencoded: o FastifyAdapter do Nest registra os parsers
  // de 'application/json' e 'application/x-www-form-urlencoded' sozinho, ambos herdando
  // o bodyLimit definido acima (fastify-adapter.js: registerJson/UrlencodedContentParser).

  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    if (!isDocsPath(req.url)) return done();

    const authHeader = req.headers.authorization;

    const user = 'admin';
    const password = 'Ac@2025acesso';

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
      reply.status(401).send('Autenticação necessária');
      return;
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');

    const [inputUser, inputPassword] = credentials.split(':');

    if (inputUser !== user || inputPassword !== password) {
      reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
      reply.status(401).send('Usuário ou senha inválidos');
      return;
    }

    done();
  });

  const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN);
  // Fallback de desenvolvimento: se CORS_ORIGIN não estiver definida, libera localhost
  if (allowedOrigins.length === 0) {
    allowedOrigins.push('http://localhost:3000');
    allowedOrigins.push('http://localhost:8000');
    allowedOrigins.push('http://localhost:8081');
    allowedOrigins.push('http://127.0.0.1:8081');
  }

  app.enableCors({
    origin: (origin, callback) => {
      const ok = isAllowedOrigin(origin, allowedOrigins);
      callback(null, ok);
    },
    credentials: true, // necessário se usar cookies/autenticação
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'Cache-Control',
      'Pragma',
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400, // cache do preflight por 1 dia
  });

  // (opcional) prefixo global
  // app.setGlobalPrefix('api');

  // === Swagger only if enabled ===
  if (process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Estoque Service API')
      .setDescription(`
      API exclusiva para o módulo de estoque da intranet AC Acessórios

      ## Funcionalidades principais:
      - **Movimentações de Estoque**: Consulta e registro de entradas/saídas
      - **Produtos**: Gerenciamento de itens e informações de estoque
      - **Relatórios**: Geração de relatórios de movimentação

      ## Autenticação:
      A API utiliza tokens de acesso enviados via header \`Authorization: Bearer <token>\`.
      `)
      .setVersion('1.0.0')
      .setContact('AC Acessórios - TI', 'https://acacessorios.com.br', 'ti@acacessorios.com.br')
      .setLicense('Proprietário', '')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT para autenticação',
        },
        'jwt',
      )
      .addServer(process.env.PUBLIC_URL ?? 'http://localhost:8000', 'Servidor de Desenvolvimento')
      .addServer('http://intranetbackend.acacessorios.local', 'Servidor de Produção')
      .build();

    const document = SwaggerModule.createDocument(app, config, {
      operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
      deepScanRoutes: true,
    });

    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        showRequestHeaders: true,
        tryItOutEnabled: true,
      },
      customSiteTitle: 'Intranet AC Acessórios — API Documentation',
      customfavIcon: '/favicon.ico',
      customJs: [
        'https://unpkg.com/swagger-ui-themes@3.0.1/themes/3.x/theme-material.css',
      ],
      customCssUrl: [
        'https://unpkg.com/swagger-ui-themes@3.0.1/themes/3.x/theme-material.css',
      ],
    });
    // UI: /docs • JSON: /docs-json
  }

  const port = parseInt(process.env.PORT || '8000', 10);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.SWAGGER_ENABLED === 'true') {
    console.log(`Swagger em http://localhost:${port}/docs`);
  }
}
bootstrap();
