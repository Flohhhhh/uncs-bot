import { WardogsClient } from "./wardogs.client";

function game(routes = ["GET /v1/server-id", "GET /v1/sponsor"]) {
  const client = new WardogsClient({
    rcon: () => {
      throw new Error("No network permitted");
    },
  });
  jest.spyOn(client, "capabilities").mockResolvedValue({ routes });
  const request = jest
    .spyOn(client, "request")
    .mockImplementation(async (_method, path) =>
      path === "/v1/server-id"
        ? { serverId: "server-123", token: "private" }
        : { imageUrl: "https://example.com/banner.png", token: "private" },
    );
  return { client, request };
}

it("reads only advertised identity routes and returns only the public fields", async () => {
  const { client, request } = game();
  expect(await client.identity()).toEqual({
    serverId: { available: true, value: "server-123" },
    banner: { available: true, value: "https://example.com/banner.png" },
  });
  expect(request.mock.calls).toEqual([
    ["GET", "/v1/server-id"],
    ["GET", "/v1/sponsor"],
  ]);
  const unsupported = game([]);
  expect(await unsupported.client.identity()).toEqual({
    serverId: { available: false, value: null },
    banner: { available: false, value: null },
  });
  expect(unsupported.request).not.toHaveBeenCalled();
});

it("preserves a readable field when the other read fails without exposing the error", async () => {
  const { client, request } = game();
  request.mockImplementation(async (_method, path) => {
    if (path === "/v1/server-id") throw new Error("private connection detail");
    return { imageUrl: "" };
  });
  expect(await client.identity()).toEqual({
    serverId: { available: true, value: null, error: "The server ID could not be read." },
    banner: { available: true, value: null },
  });
});

it.each([
  "javascript:alert(1)",
  "data:image/svg+xml,<svg/>",
  "https://user:password@example.com/a.png",
  "https://example.com/a\n.png",
  "not a URL",
  42,
  undefined,
  "a".repeat(2049),
])("does not expose an invalid banner URL (%s)", async (value) => {
  const { client, request } = game(["GET /v1/sponsor"]);
  request.mockResolvedValue({ imageUrl: value });
  expect((await client.identity()).banner).toEqual({
    available: true,
    value: null,
    error: "The current banner could not be read.",
  });
  expect(request).toHaveBeenCalledTimes(1);
});
