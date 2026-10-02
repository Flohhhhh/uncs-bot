export type AutomaticVoteStatus = {
  enabled: boolean;
  delaySeconds: number;
  closesAtScore: number;
  choices: number;
  message: string;
  checkedAt: string | null;
};

export type MapVoteSetup = {
  serverId: string;
  checkedAt: string;
  checks: { label: string; status: "ok" | "blocked" | "review"; message: string }[];
};
