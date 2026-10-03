import { HttpException, Injectable } from "@nestjs/common";
import { MessageFlags } from "discord.js";
import { Button, ComponentParam, Context, type ButtonContext } from "necord";
import { voteChoiceTitle } from "../../common/voting-policy";
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
      // Same number and title as the button, so a voter can see which choice was recorded.
      message = `Your vote is now choice ${Number(choice) + 1}: ${voteChoiceTitle(selection).slice(0, 150)}. You can choose again until the ballot closes.`;
    } catch (error) {
      message =
        error instanceof HttpException
          ? error.message
          : "Your vote could not be confirmed. Try again while the ballot is open.";
    }
    await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
  }
}
