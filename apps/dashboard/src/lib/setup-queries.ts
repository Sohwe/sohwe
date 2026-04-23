import { api } from "./api";
import type { Me, SetupStatus } from "./types";

export function fetchSetupStatus(): Promise<SetupStatus> {
  return api<SetupStatus>("/api/setup/status");
}

export type { Me, SetupStatus };
