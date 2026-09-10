import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { NecordExecutionContext, type SlashCommandContext } from "necord";
import { ActivityLogger } from "./activity-logger.service";

@Injectable()
export class CommandLoggingInterceptor implements NestInterceptor {
  constructor(private readonly activityLogger: ActivityLogger) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const necordContext = NecordExecutionContext.create(context);
    const discovery = necordContext.getDiscovery();

    if (necordContext.getType() === "necord" && discovery?.isSlashCommand()) {
      const [interaction] = necordContext.getContext<SlashCommandContext>();

      if (interaction?.isChatInputCommand()) {
        const subcommandGroup = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand(false);
        const command = [interaction.commandName, subcommandGroup, subcommand].filter(Boolean).join(" ");

        this.activityLogger.logCommand({
          command,
          actor: interaction.user.tag,
          actorId: interaction.user.id,
          guild: interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : undefined,
        });
      }
    }

    return next.handle();
  }
}
