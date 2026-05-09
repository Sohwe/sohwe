import { api } from "./api";
import type { Me, SetupStatus } from "./types";

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const s = await api<SetupStatus>("/api/setup/status");
  const gate = Boolean(s.setupGateActive);
  return {
    needsSetup: s.needsSetup,
    setupGateActive: gate,
    setupUnlocked: s.setupUnlocked ?? !gate
  };
}

export type { Me, SetupStatus };
