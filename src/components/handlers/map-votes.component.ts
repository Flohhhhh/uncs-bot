import { HttpException, Injectable } from "@nestjs/common";
import { MessageFlags } from "discord.js";
import { Button, ComponentParam, Context, type ButtonContext } from "necord";
import { MapVotesService } from "../../map-votes/map-votes.service";

@Injectable()
export class MapVotesComponent {
  constructor(private readonly votes: MapVotesService) {}
  @Button("uncs-map-vote/:id/:choice")
  async vote(
    @Context() [interaction]: ButtonContext,
    @ComponentParam("id") id: string,
    @ComponentParam("choice") choice: string,
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let message: string;
    try {
      const selection = await this.votes.cast(
        id,
        choice,
        interaction.user.id,
        interaction.guildId,
        interaction.channelId,
        interaction.message.id,
        interaction.inCachedGuild() && !interaction.member.pending && !interaction.user.bot,
      );
      message = `Your vote is now ${selection.map}. You can choose again until the ballot closes.`;
    } catch (error) {
      message =
        error instanceof HttpException
          ? error.message
          : "Your vote could not be confirmed. Try again while the ballot is open.";
    }
    await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
  }
}
