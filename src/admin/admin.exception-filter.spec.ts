import { BadRequestException, type ArgumentsHost } from "@nestjs/common";
import { AdminExceptionFilter } from "./admin.controller";

function respond(error: unknown) {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new AdminExceptionFilter().catch(error, host);
  return { status: res.status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe("dashboard error responses", () => {
  it("names the field of a locally raised validation error so a form can highlight it", () => {
    expect(
      respond(
        new BadRequestException({
          message: "Close score must be at least 5 points above the opening ceiling.",
          path: ["settings", "openScoreCeiling"],
        }),
      ),
    ).toEqual({
      status: 400,
      body: {
        message: "Close score must be at least 5 points above the opening ceiling.",
        path: ["settings", "openScoreCeiling"],
      },
    });
  });
  it("keeps other errors to a plain message", () => {
    expect(respond(new BadRequestException("Review the voting controls."))).toEqual({
      status: 400,
      body: { message: "Review the voting controls." },
    });
    expect(respond(new BadRequestException({ message: "Bad", path: [{ secret: true }] })).body).toEqual({
      message: "Bad",
    });
    expect(respond(new Error("postgres://private")).body).toEqual({
      message: "The dashboard is unavailable. Check its connection and database setup.",
    });
  });
});
