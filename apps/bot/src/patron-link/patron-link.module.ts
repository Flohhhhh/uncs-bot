import { Module } from "@nestjs/common";
import { PatronLinkService } from "./patron-link.service";
@Module({ providers: [PatronLinkService], exports: [PatronLinkService] })
export class PatronLinkModule {}
