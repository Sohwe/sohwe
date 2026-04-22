import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DockerBuildOptions = {
  contextDir: string;
  imageTag: string;
  onLogLine: (line: string) => void;
};

/**
 * Build a Docker image from `contextDir` (must contain a Dockerfile for Phase 1).
 * Streams stdout/stderr to `onLogLine`.
 * @returns Promise that rejects on non-zero `docker build` exit code
 */
export async function dockerBuild(opts: DockerBuildOptions): Promise<void> {
  const { contextDir, imageTag, onLogLine } = opts;
  if (!existsSync(join(contextDir, "Dockerfile"))) {
    throw new Error(
      "No Dockerfile in repository root. Phase 1 only supports Docker builds."
    );
  }

  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "docker",
      ["build", "-t", imageTag, contextDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const forward = (buf: Buffer) => {
      const s = buf.toString();
      for (const line of s.split(/\r?\n/)) {
        if (line) onLogLine(line);
      }
    };

    p.stdout?.on("data", forward);
    p.stderr?.on("data", forward);
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`docker build failed with exit code ${String(code)}`)
        );
    });
  });
}
