import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { ServiceCallError } from "@uncs/api-client";
import type { Response } from "express";
@Catch()
export class InternalExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const failure = error as { status?: number; code?: number; reason?: string; settled?: boolean };
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof ServiceCallError && error.outcome === "rejected"
          ? (error.status ?? 400)
          : typeof failure.status === "number" && failure.status >= 400 && failure.status < 500
            ? failure.status
            : 503;
    res.status(status).json({
      message:
        error instanceof HttpException && status < 500
          ? error.message
          : status < 500
            ? "The service refused this operation."
            : "The operation could not be confirmed.",
      outcome: status < 500 ? "rejected" : "unknown",
      ...(typeof failure.code === "number" && [10007, 10013, 10011, 50013, 50001].includes(failure.code)
        ? { code: failure.code }
        : {}),
      ...(failure.reason === "posted check unavailable"
        ? { reason: failure.reason, settled: failure.settled === true }
        : {}),
    });
  }
}
