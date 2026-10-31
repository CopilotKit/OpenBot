import type { AppVariables } from "../auth/guards";

export type RecorderVariables = AppVariables & {
  recorderConnectionId?: string;
};
