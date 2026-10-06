import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { acknowledged, alertChannel, messageId, type AlertDisplay } from "@uncs/contracts";
import { RemoteService } from "../internal/transport";
function display(record: AlertDisplay) {
  const { id, serverName, severity, title, lines, player, fields, links, createdAt } = record;
  return { id, serverName, severity, title, lines, player, fields, links, createdAt };
}
@Injectable()
export class StaffAlertsDiscord {
  constructor(private readonly remote: RemoteService) {}
  async check() {
    try {
      return await this.remote.request("/internal/v1/alerts/channel", alertChannel);
    } catch {
      return { state: "discord-offline" as const, channelId: null, ping: "off" as const };
    }
  }
  send(record: AlertDisplay, ping: boolean) {
    return this.remote.request("/internal/v1/alerts/send", messageId, {
      record: display(record),
      ping,
      operationId: `staff-alert:${record.id}`,
    });
  }
  edit(record: AlertDisplay, messageId: string, note: string) {
    return this.remote.request("/internal/v1/alerts/edit", acknowledged, {
      record: display(record),
      messageId,
      note,
      operationId: randomUUID(),
    });
  }
}
