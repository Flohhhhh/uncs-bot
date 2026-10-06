import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { ServiceClient } from "@uncs/api-client";
import type { Request } from "express";
import type { z } from "zod";

@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const token = process.env.BOT_TO_API_TOKEN;
    const presented = request.headers.authorization;
    if (
      !token ||
      token.length < 32 ||
      !presented ||
      request.headers.cookie ||
      Buffer.byteLength(presented) !== Buffer.byteLength(token) + 7 ||
      !timingSafeEqual(Buffer.from(presented), Buffer.from(`Bearer ${token}`))
    )
      throw new UnauthorizedException("Invalid service credential.");
    return true;
  }
}
@Injectable()
export class RemoteService {
  private client?: ServiceClient;
  request<T>(path: `/internal/v1/${string}`, schema: z.ZodType<T>, body?: unknown) {
    this.client ??= new ServiceClient(
      process.env.BOT_ORIGIN ?? "http://127.0.0.1:4330",
      process.env.API_TO_BOT_TOKEN ?? "",
    );
    return this.client.request(path, schema, body);
  }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Invalid service request.");
  return parsed.data;
}
@Global()
@Module({ providers: [RemoteService, InternalGuard], exports: [RemoteService, InternalGuard] })
export class TransportModule {}
