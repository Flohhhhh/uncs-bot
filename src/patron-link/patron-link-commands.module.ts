import { Module } from "@nestjs/common";
import { PatronLinkCommand } from "./patron-link.command";
import { PatronLinkModule } from "./patron-link.module";

/**
 * Whether /patreon is registered: only for PATREON_LINK_ENABLED=true exactly. ConditionalModule's string form would
 * also register it while the setting is unset, so app.module.ts passes this test instead.
 */
export const patronLinkCommandsEnabled = (env: NodeJS.ProcessEnv) => env.PATREON_LINK_ENABLED === "true";

/** The /patreon command. Its panel button is handled in ComponentsModule whether or not this is registered. */
@Module({
  imports: [PatronLinkModule],
  providers: [PatronLinkCommand],
})
export class PatronLinkCommandsModule {}
