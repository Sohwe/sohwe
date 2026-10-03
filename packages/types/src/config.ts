import { z } from "zod";
import { isAlias, isMap, isSeq, LineCounter, parseDocument } from "yaml";
import { AppDirectorySchema, CONFIG_FIELDS, ConfigPathSchema, DockerfilePathSchema, DockerTargetSchema, EnvKeySchema, type ConfigField } from "./index";

export const SohweConfigSchema = z.object({
  version: z.literal(1),
  application: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    directory: AppDirectorySchema.optional(),
    build: z.object({
      mode: z.enum(["auto", "dockerfile", "nixpacks"]).optional(),
      dockerfile: DockerfilePathSchema.optional(),
      target: DockerTargetSchema.optional(),
      command: z.string().min(1).max(4096).optional(),
      startCommand: z.string().min(1).max(4096).optional()
    }).strict().optional(),
    runtime: z.object({
      port: z.number().int().min(1).max(65535).optional(),
      command: z.string().min(1).max(4096).optional()
    }).strict().optional(),
    variables: z.array(z.object({
      key: EnvKeySchema,
      scope: z.enum(["runtime", "build", "both"]).default("runtime"),
      required: z.boolean().default(false),
      description: z.string().max(500).optional()
    }).strict()).max(500).optional()
  }).strict()
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.application.variables?.forEach((item, index) => {
    if (seen.has(item.key)) ctx.addIssue({ code: "custom", message: `Duplicate variable name ${item.key}`, path: ["application", "variables", index, "key"] });
    seen.add(item.key);
  });
  const build = config.application.build;
  if (build?.mode === "nixpacks" && (build.dockerfile || build.target)) {
    ctx.addIssue({ code: "custom", message: "Dockerfile and target require Dockerfile or auto mode", path: ["application", "build"] });
  }
  if ((build?.command || build?.startCommand) && build.mode !== "nixpacks") {
    ctx.addIssue({ code: "custom", message: "Build and start commands require mode: nixpacks; use runtime.command for a Docker image", path: ["application", "build"] });
  }
});
export type SohweConfig = z.infer<typeof SohweConfigSchema>;

export type PlanValues = {
  appDirectory: string;
  buildMode: "auto" | "dockerfile" | "nixpacks";
  dockerfilePath: string;
  dockerTarget: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  runtimeCmd: string | null;
  port: number;
};
export type ResolvedPlan = { values: PlanValues; sources: Record<ConfigField, "override" | "file" | "detected" | "default"> };

export function configValues(config: SohweConfig): Partial<PlanValues> {
  const app = config.application;
  return {
    ...(app.directory !== undefined ? { appDirectory: app.directory } : {}),
    ...(app.build?.mode !== undefined ? { buildMode: app.build.mode } : {}),
    ...(app.build?.dockerfile !== undefined ? { dockerfilePath: app.build.dockerfile } : {}),
    ...(app.build?.target !== undefined ? { dockerTarget: app.build.target } : {}),
    ...(app.build?.command !== undefined ? { buildCmd: app.build.command } : {}),
    ...(app.build?.startCommand !== undefined ? { startCmd: app.build.startCommand } : {}),
    ...(app.runtime?.command !== undefined ? { runtimeCmd: app.runtime.command } : {}),
    ...(app.runtime?.port !== undefined ? { port: app.runtime.port } : {})
  };
}

export function resolveSohwePlan(detected: PlanValues, config: SohweConfig | null, overrides: readonly ConfigField[], saved: PlanValues): ResolvedPlan {
  const file = config ? configValues(config) : {};
  const values = { ...detected };
  const sources = {} as ResolvedPlan["sources"];
  for (const field of CONFIG_FIELDS) {
    if (overrides.includes(field)) {
      // TypeScript cannot prove that the indexed members have matching types.
      Object.assign(values, { [field]: saved[field] });
      sources[field] = "override";
    } else if (Object.hasOwn(file, field)) {
      Object.assign(values, { [field]: file[field] });
      sources[field] = "file";
    } else {
      sources[field] = field === "port" && detected.port === 3000 ? "default" : "detected";
    }
  }
  return { values, sources };
}

/** Parse YAML as bounded data; error text never includes file contents or secret values. */
export function parseSohweConfig(text: string, path = "sohwe.yaml"): SohweConfig {
  ConfigPathSchema.parse(path);
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error(`${path}:1:1: Config file exceeds 64 KiB`);
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  if (document.errors.length) {
    const pos = lines.linePos(document.errors[0]?.pos[0] ?? 0);
    throw new Error(`${path}:${pos.line}:${pos.col}: Invalid YAML syntax`);
  }
  function visit(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const item = node as { tag?: string; range?: [number, number] };
    if (isAlias(node) || item.tag) {
      const pos = lines.linePos(item.range?.[0] ?? 0);
      throw new Error(`${path}:${pos.line}:${pos.col}: YAML aliases and tags are not supported`);
    }
    if (isMap(node)) for (const pair of node.items) { visit(pair.key); visit(pair.value); }
    if (isSeq(node)) for (const child of node.items) visit(child);
  }
  visit(document.contents);
  const parsed = SohweConfigSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const issuePath = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path;
    const node = document.getIn(issuePath, true) as { range?: [number, number] } | undefined;
    const parent = document.getIn(issue.path, true) as { range?: [number, number] } | undefined;
    const pos = lines.linePos(node?.range?.[0] ?? parent?.range?.[0] ?? 0);
    throw new Error(`${path}:${pos.line}:${pos.col}: ${issuePath.join(".") || "config"}: ${issue.message}`);
  }
  return parsed.data;
}
