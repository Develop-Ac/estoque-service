// metrics.interceptor.ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';
import { Observable, tap } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric('http_request_duration_seconds')
    private histogram: Histogram<string>,
  ) {}

  // No Fastify não existe req.route.path; o template da rota vem de routeOptions.url.
  // Sem isso cada id vira um label distinto e a cardinalidade do Prometheus explode.
  private routeLabel(req: FastifyRequest): string {
    return req.routeOptions?.url ?? (req as any).routerPath ?? req.url;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const end = this.histogram.startTimer();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<FastifyReply>();
          end({
            method: req.method,
            route: this.routeLabel(req),
            status_code: res.statusCode,
          });
        },
        error: () => {
          end({ method: req.method, route: this.routeLabel(req), status_code: 500 });
        },
      }),
    );
  }
}
