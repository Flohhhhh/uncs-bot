import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { StartupState } from "./startup/startup";

@Controller()
export class AppController {
  constructor(private readonly startup: StartupState) {}

  @Get()
  staffEntry(@Res() response: Response) {
    response.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }).redirect(302, "/admin");
  }

  /** 503 until startup, including the Discord sign-in, has finished; Railway's health check waits for the 200. */
  @Get("health")
  healthCheck(@Res({ passthrough: true }) response: Response) {
    if (this.startup.complete) return { status: "ok" };
    response.status(503);
    return { status: "starting" };
  }
}
