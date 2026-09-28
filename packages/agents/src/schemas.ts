import { z } from 'zod';
import { FINDING_CODES, ROOT_CAUSES } from '@payops/shared';
import { FOLLOWUP_TOOLS, type ToolDef } from './tools';

/**
 * Builds a per-specialist follow-up schema (docs/03 §2 "investigative pass") whose Zod enum only
 * allows tools from that specialist's own group, so a specialist's follow-up choice can never
 * name another agent's tool (docs/03 §3/§8 "never contains"). Returns `null` when the group has
 * no follow-up tools at all (Risk, until Phase 4 task 5 adds risk tools) — callers skip the LLM
 * call entirely in that case rather than building a schema with an empty `z.enum`.
 */
export function buildFollowUpChoiceSchema(tools: readonly ToolDef[]) {
  if (tools.length === 0) return null;
  const toolNames = tools.map((t) => t.name) as [string, ...string[]];
  return z.object({
    followUps: z
      .array(
        z.object({
          tool: z.enum(toolNames),
          reason: z.string().trim().min(3).max(200),
        }),
      )
      .max(6),
  });
}

/** The combined-tool schema, kept for `prompts.test.ts`'s default `followUpPrompt` call; each
 * specialist node now builds its own narrower schema via `buildFollowUpChoiceSchema`. */
export const FollowUpChoiceSchema = buildFollowUpChoiceSchema(FOLLOWUP_TOOLS)!;
export type FollowUpChoice = z.infer<typeof FollowUpChoiceSchema>;

/** LLM call #2 of `investigate`: typed findings citing evidence ids (docs/03 §7). */
export const FindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        code: z.enum(FINDING_CODES),
        statement: z.string().trim().min(3).max(300),
        evidenceIds: z.array(z.string().min(1)).min(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(8),
});
export type FindingsAnswer = z.infer<typeof FindingsSchema>;

/** `resolve`'s LLM call on the full path: the diagnosis (docs/03 §6). */
export const DiagnosisSchema = z.object({
  rootCause: z.enum(ROOT_CAUSES),
  narrative: z.string().trim().min(3).max(400),
  confidence: z.number().min(0).max(1),
  supportingFindingIds: z.array(z.string()),
});
export type DiagnosisAnswer = z.infer<typeof DiagnosisSchema>;
