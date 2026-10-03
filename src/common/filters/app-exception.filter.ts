import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { BaseInteraction, DiscordAPIError } from "discord.js";
import { STATUS_CODES } from "node:http";
import { InteractionError } from "../errors/interaction-error";

/** Fixed replies for client errors raised by Express's own middleware, such as body-parser's. */
const CLIENT_ERROR_MESSAGES: Record<number, string> = {
  400: "Bad request.",
  413: "Request body too large.",
  415: "Unsupported request encoding.",
};

/**
 * The 4xx status of a client error from Express's own middleware, such as body-parser's 413 for an oversized
 * body. http-errors marks those with `expose`; a Discord or upstream error's status is not the caller's fault.
 */
function clientErrorStatus(exception: any): number | undefined {
  if (exception?.expose !== true) return undefined;
  const status = typeof exception.status === "number" ? exception.status : exception.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : undefined;
}

@Catch()
@Injectable()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  private shouldLog(exception: any, host: ArgumentsHost): boolean {
    try {
      const type = host.getType<string>();
      let isInteraction = false;

      if (type === "necord") {
        const [context] = host.getArgs();
        if (!context) return true;

        const [interaction] = context;
        if (interaction instanceof BaseInteraction) {
          isInteraction = true;
        }
      }

      if (exception instanceof InteractionError) {
        return !isInteraction; // Log InteractionErrors outside of interaction contexts
      }

      if (exception instanceof DiscordAPIError) {
        // Don't log common Discord API errors that are out of our control anyway
        return !["50013", "50001", "10008"].includes(`${exception.code}`);
      }
    } catch {
      // If anything goes wrong, log the error
    }
    return true;
  }

  async catch(exception: any, host: ArgumentsHost) {
    const type = host.getType<string>();

    if (this.shouldLog(exception, host)) {
      this.logger.error(exception?.stack || exception?.message || String(exception));
    }

    // Handle Necord (Discord) execution contexts
    if (type === "necord") {
      const [context] = host.getArgs();
      if (!context) return;

      const [interaction] = context;
      if (interaction instanceof BaseInteraction) {
        await InteractionError.reply(interaction, exception, this.logger);
      }
      return;
    }

    // Handle HTTP contexts
    if (type === "http") {
      const ctx = host.switchToHttp();
      const res = ctx.getResponse();
      const clientStatus = typeof exception?.getStatus === "function" ? undefined : clientErrorStatus(exception);
      const status =
        typeof exception?.getStatus === "function"
          ? exception.getStatus()
          : (clientStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);

      // Only an HttpException's response is written for the client. Any other error's message can hold
      // internals such as a filesystem path, so it stays in the log above.
      const body =
        typeof exception?.getResponse === "function"
          ? exception.getResponse()
          : {
              statusCode: status,
              message: clientStatus
                ? (CLIENT_ERROR_MESSAGES[clientStatus] ?? `${STATUS_CODES[clientStatus] ?? "Request refused"}.`)
                : "Internal server error.",
            };

      return res.status(status).json(body);
    }
  }
}
