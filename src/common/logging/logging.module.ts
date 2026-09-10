import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ActivityLogger } from "./activity-logger.service";
import { CommandLoggingInterceptor } from "./command-logging.interceptor";
import { EventLoggingInterceptor } from "./event-logging.interceptor";

@Global()
@Module({
  providers: [
    ActivityLogger,
    { provide: APP_INTERCEPTOR, useClass: CommandLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EventLoggingInterceptor },
  ],
  exports: [ActivityLogger],
})
export class LoggingModule {}
