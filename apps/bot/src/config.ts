export const config = {
  channels: {
    general: process.env.DISCORD_GENERAL_CHANNEL_ID || "1546923296568778893",
    squadUp: process.env.DISCORD_SQUAD_UP_CHANNEL_ID || "327209891708141568",
    lobby: process.env.DISCORD_LOBBY_CHANNEL_ID || "1546924372948815882",
  },
} as const;
