import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { apiGet } from "./api";
import type { ProjectRow } from "./types";

export const activeRelease = (status: string) =>
  ["pending", "building", "releasing", "deploying"].includes(status);

export function useProject() {
  const { projectId } = useParams({ strict: false });
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => apiGet<ProjectRow>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
    refetchInterval: 5_000,
  });
}

export function projectServiceHost(
  projectSlug: string,
  serviceSlug: string,
  baseDomain: string,
) {
  return `${projectSlug}-${serviceSlug}.${baseDomain}`;
}
