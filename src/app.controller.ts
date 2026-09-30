import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";

@Controller()
export class AppController {
  @Get()
  staffEntry(@Res() response: Response) {
    response.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }).redirect(302, "/admin");
  }

  @Get("health")
  healthCheck() {
    return { status: "ok" };
  }
}
