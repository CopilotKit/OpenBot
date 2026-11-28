import type { FrameConfig } from "../frameConfig";
export type Scene = {
  id: string;
  title: string;
  group: "Setup";
  start: Pick<FrameConfig, "hash" | "search"> &
    Partial<Pick<FrameConfig, "os" | "env" | "answers">>;
};
