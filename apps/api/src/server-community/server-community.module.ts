import { CommunityDiscord } from "./community.discord";
import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ServerCommunityService } from "./server-community.service";
import { ServerCommunityController } from "./server-community.controller";

@Module({
  imports: [AdminModule],
  providers: [CommunityDiscord, ServerCommunityService],
  controllers: [ServerCommunityController],
})
export class ServerCommunityModule {}
