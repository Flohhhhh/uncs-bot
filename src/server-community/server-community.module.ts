import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { ServerCommunityService } from "./server-community.service";

@Module({ imports: [AdminModule], providers: [ServerCommunityService] })
export class ServerCommunityModule {}
