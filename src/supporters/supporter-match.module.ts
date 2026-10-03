import { Module } from "@nestjs/common";
import { DiscordRolesModule } from "../discord-roles/discord-roles.module";
import { SupporterMatchService } from "./supporter-match.service";
import { SupporterMatchStore } from "./supporter-match.store";

/**
 * Automatic supporter matching. It imports neither Supporters nor Applications (DATABASE and EnvService are global),
 * so both can import it to trigger matching without a cycle.
 */
@Module({
  imports: [DiscordRolesModule],
  providers: [SupporterMatchStore, SupporterMatchService],
  exports: [SupporterMatchService],
})
export class SupporterMatchModule {}
