import { z } from "zod";

export const FirstRunSetupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  organizationName: z.string().min(1)
});
export type FirstRunSetupInput = z.infer<typeof FirstRunSetupSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const CreateApplicationSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  gitRepo: z.string().url(),
  gitBranch: z.string().default("main"),
  port: z.number().int().min(1).max(65535).default(3000),
  buildMode: z.enum(["auto", "dockerfile", "nixpacks"]).default("auto"),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  domain: z.string().optional()
});
export type CreateApplicationInput = z.infer<typeof CreateApplicationSchema>;