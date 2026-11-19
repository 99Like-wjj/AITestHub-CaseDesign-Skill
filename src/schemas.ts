import { z } from 'zod';
import { providedApiContentSchema } from './published-contracts.js';

export const CONTRACT_VERSION = 'ath.contracts.v1' as const;
export const DRAFT_VERSION = 'ath.case-design.draft.v2' as const;
export const uuidSchema = z.uuid();
const localId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const title = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(100_000);
export const basisRefSchema = z.strictObject({
  kind: z.enum(['material', 'knowledge', 'rule', 'explicitStatement']),
  objectId: uuidSchema.optional(),
  revisionId: uuidSchema.optional(),
  locator: z.string().max(2000).optional(),
  description: z.string().min(1).max(4000),
  readability: z.enum(['readable', 'unreadable', 'notChecked', 'partial']),
});
const basisRefs = z.array(basisRefSchema).max(100);
export const existingBaseSchema = z.strictObject({
  id: uuidSchema,
  baseRevisionId: uuidSchema,
  action: z.enum(['reference', 'revise']),
  rowVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const node = {
  localId,
  title,
  basisRefs,
  existing: existingBaseSchema.optional(),
};
export const setDraftSchema = z.strictObject(node);
export const scenarioDraftSchema = z.strictObject({
  ...node,
  setLocalId: localId,
  objective: text,
  sharedPreconditions: z.array(z.string().max(10_000)).max(100),
});
const caseFields = {
  localId,
  scenarioLocalId: localId,
  title,
  testPoint: text,
  preconditions: z.array(z.string().max(10_000)).max(100),
  expected: text,
  basisRefs,
};
const uiStepsSchema = z
  .array(
    z.strictObject({
      action: z.string().trim().min(1).max(10_000),
      expected: z.string().trim().min(1).max(10_000).optional(),
    }),
  )
  .min(1)
  .max(100);

export const uiCaseDraftSchema = z.strictObject({
  ...caseFields,
  kind: z.literal('UI'),
  steps: uiStepsSchema.optional(),
  existing: existingBaseSchema.optional(),
});
export const apiProposalSchema = z.strictObject({
  ...caseFields,
  kind: z.literal('API'),
  readiness: z.literal('proposal'),
  missing: z.array(z.string().min(1).max(4000)).min(1).max(100),
});
export const apiProvidedCaseDraftSchema = z.strictObject({
  localId,
  scenarioLocalId: localId,
  kind: z.literal('API'),
  readiness: z.literal('providedExecutable'),
  providedContent: providedApiContentSchema,
  sourceDescription: z.string().trim().min(1).max(4000),
  parentMapping: z.literal('selectedScenario'),
  existing: existingBaseSchema.optional(),
});
export const draftSchema = z
  .strictObject({
    schemaVersion: z.literal(DRAFT_VERSION),
    draftId: uuidSchema,
    intent: z.enum(['generate', 'organize', 'optimize']),
    projectId: uuidSchema,
    requirementVersionId: uuidSchema,
    kind: z.enum(['UI', 'API']),
    mode: z.enum(['incremental', 'completeSet']),
    sets: z.array(setDraftSchema).min(1).max(1000),
    scenarios: z.array(scenarioDraftSchema).max(10_000),
    cases: z
      .array(
        z.union([
          uiCaseDraftSchema,
          apiProposalSchema,
          apiProvidedCaseDraftSchema,
        ]),
      )
      .max(10_000),
    gaps: z
      .array(
        z.strictObject({
          id: localId,
          localIds: z.array(localId).max(10_000),
          description: z.string().min(1).max(4000),
          blocksSubmission: z.boolean(),
        }),
      )
      .max(1000),
    optimizationNotes: z
      .array(
        z.strictObject({
          localId,
          assetLocalId: localId,
          target: z.enum(['writtenRevision', 'baseRevision']),
          notes: z
            .array(
              z.strictObject({
                opinionId: uuidSchema,
                sourceOpinionRevisionId: uuidSchema,
                note: z.string().trim().min(1).max(10_000),
              }),
            )
            .min(1)
            .max(1000),
        }),
      )
      .max(1000),
  })
  .superRefine((draft, ctx) => {
    const nodes = [...draft.sets, ...draft.scenarios, ...draft.cases];
    const names = nodes.map((n) => n.localId);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', message: '本地资产标识必须唯一' });
    const formalIds = nodes.flatMap((n) =>
      'existing' in n && n.existing ? [n.existing.id] : [],
    );
    if (new Set(formalIds).size !== formalIds.length)
      ctx.addIssue({
        code: 'custom',
        message: '同一正式对象不得映射为多个本地对象',
      });
    for (const scenario of draft.scenarios)
      if (!draft.sets.some((s) => s.localId === scenario.setLocalId))
        ctx.addIssue({ code: 'custom', message: '场景缺少本批次父项' });
    for (const item of draft.cases) {
      if (
        item.kind !== draft.kind ||
        !draft.scenarios.some((s) => s.localId === item.scenarioLocalId)
      )
        ctx.addIssue({ code: 'custom', message: '用例类型/父项不一致' });
    }
    for (const gap of draft.gaps)
      if (gap.localIds.some((id) => !names.includes(id)))
        ctx.addIssue({ code: 'custom', message: '缺口引用了未知本地资产' });
    const noteIds = draft.optimizationNotes.map((n) => n.localId);
    if (
      new Set(noteIds).size !== noteIds.length ||
      noteIds.some((id) => names.includes(id))
    )
      ctx.addIssue({ code: 'custom', message: '说明标识重复或与资产标识重叠' });
    for (const note of draft.optimizationNotes) {
      const target = nodes.find((n) => n.localId === note.assetLocalId);
      if (!target || !('existing' in target) || !target.existing)
        ctx.addIssue({
          code: 'custom',
          message: '优化说明必须指向已有正式资产并明确意见来源修订',
        });
      if (
        note.target === 'writtenRevision' &&
        (!target ||
          !('existing' in target) ||
          target.existing?.action !== 'revise')
      )
        ctx.addIssue({
          code: 'custom',
          message: '本地写回修订目标必须有实际revise操作',
        });
      if (
        new Set(note.notes.map((n) => n.opinionId)).size !== note.notes.length
      )
        ctx.addIssue({ code: 'custom', message: '同一说明不得重复意见' });
    }
  });
export type Draft = z.infer<typeof draftSchema>;
export type UiCaseDraft = z.infer<typeof uiCaseDraftSchema>;

export const setContentSchema = z.strictObject({ title, basisRefs });
export const scenarioContentSchema = z.strictObject({
  kind: z.enum(['UI', 'API']),
  requirementVersionId: uuidSchema,
  setId: uuidSchema,
  title,
  objective: text,
  sharedPreconditions: z.array(z.string().max(10_000)).max(100),
  basisRefs,
});
export const uiContentSchema = z.strictObject({
  kind: z.literal('UI'),
  scenarioId: uuidSchema,
  title,
  testPoint: text,
  preconditions: z.array(z.string().max(10_000)).max(100),
  steps: uiStepsSchema.optional(),
  expected: text,
  basisRefs,
});
export const assetProjectionSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  kind: z.enum(['UI', 'API']),
  requirementVersionId: uuidSchema,
  setId: uuidSchema,
  parentId: uuidSchema.nullable(),
  targetType: z.enum(['set', 'scenario', 'case']),
  title,
  revisionId: uuidSchema,
  revisionNo: z.number().int().min(1),
  rowVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  reviewState: z.enum([
    'pending',
    'needsOptimization',
    'aiOptimized',
    'approved',
  ]),
  removedAt: z.string().nullable(),
  content: z.union([
    setContentSchema,
    scenarioContentSchema,
    uiContentSchema,
    providedApiContentSchema,
  ]),
});
export type AssetProjection = z.infer<typeof assetProjectionSchema>;

export function parseDraft(value: unknown): Draft {
  return draftSchema.parse(value);
}
