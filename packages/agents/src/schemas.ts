import { z } from 'zod';
import { FINDING_CODES, ROOT_CAUSES } from '@payops/shared';
import { FOLLOWUP_TOOLS } from './tools';

const followUpToolNames = FOLLOWUP_TOOLS.map((t) => t.name) as [string, ...string[]];

/** LLM call #1 of `investigate`: which optional tools (if any) to call next, bounded. */
export const FollowUpChoiceSchema = z.object({
  followUps: z
    .array(
      z.object({
        tool: z.enum(followUpToolNames),
        reason: z.string().trim().min(3).max(200),
      }),
    )
    .max(6),
});
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
