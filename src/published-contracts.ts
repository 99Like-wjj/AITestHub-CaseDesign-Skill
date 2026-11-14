import { z } from 'zod';
import snapshot from './published-contracts.json' with { type: 'json' };
import { CaseDesignError } from './ports.js';

// Copied by the hash-checking development importer, never fetched at runtime.
const tools = new Map<string, unknown>(
  snapshot.tools.map((t) => [t.name, t.inputSchema]),
);
const validators = new Map<string, z.ZodType[]>();
const wrapperSchema = z.strictObject({
  $schema: z.string().optional(),
  type: z.literal('object').optional(),
  anyOf: z.array(z.unknown()),
  $defs: z.record(z.string(), z.unknown()).optional(),
});
function branchesFor(raw: unknown, op: string): Record<string, unknown>[] {
  const branch = z.record(z.string(), z.unknown()).parse(raw);
  const discriminator = z
    .object({ properties: z.object({ op: z.object({ const: z.string() }) }) })
    .safeParse(raw);
  if (discriminator.success)
    return discriminator.data.properties.op.const === op ? [branch] : [];
  const wrapper = wrapperSchema.parse(raw);
  return wrapper.anyOf.flatMap((value) => branchesFor(value, op));
}
const asset = z.fromJSONSchema(
  snapshot.components['assets.assetSchema'] as Parameters<
    typeof z.fromJSONSchema
  >[0],
);
export const contractProvenance = Object.freeze(snapshot.provenance);
export function assertPublishedInput(
  name: string,
  args: Record<string, unknown>,
): void {
  const raw = tools.get(name);
  if (!raw)
    throw new CaseDesignError(
      'UNSUPPORTED_TOOL',
      '本业务包没有该已发布结构契约。',
    );
  const op = z.object({ op: z.string() }).parse(args).op,
    cacheKey = `${name}/${op}`;
  let schemas = validators.get(cacheKey);
  if (!schemas) {
    const root = z.record(z.string(), z.unknown()).parse(raw),
      branches = branchesFor(raw, op);
    if (!branches.length)
      throw new CaseDesignError(
        'UNSUPPORTED_TOOL_OPERATION',
        '发布契约没有此精确op。',
      );
    schemas = branches.map((branch) =>
      z.fromJSONSchema({
        ...branch,
        ...(root.$defs ? { $defs: root.$defs } : {}),
      } as Parameters<typeof z.fromJSONSchema>[0]),
    );
    validators.set(cacheKey, schemas);
  }
  // Exact op selection avoids observed whole-root anyOf+$defs conversion loosening.
  // Only check validity; never submit transformed/stripped parse output.
  if (schemas.some((schema) => schema.safeParse(args).success)) return;
  schemas[0]!.parse(args);
}
export function assertPublishedAsset(value: unknown): void {
  asset.parse(value);
}

export interface ApiCaseContent {
  kind: 'API';
  scenarioId: string;
  title: string;
  testPoint: string;
  preconditions: string[];
  expected: string;
  basisRefs: unknown[];
  dslVersion: 'ath.api-case.v1';
  variables: Record<string, unknown>;
  steps: { stepId: string; [key: string]: unknown }[];
  cleanup: {
    mode: string;
    steps?: { cleanupStepId: string; [key: string]: unknown }[];
  };
  [key: string]: unknown;
}
const publishedApi = z.fromJSONSchema(
  snapshot.components['domain.apiCaseContentSchema'] as Parameters<
    typeof z.fromJSONSchema
  >[0],
);
// Validation only: preserve the user's complete content, without defaults or stripping.
export const providedApiContentSchema = z.custom<ApiCaseContent>(
  (value) => {
    if (!publishedApi.safeParse(value).success) return false;
    const body = value as ApiCaseContent;
    const steps = body.steps.map((s) => s.stepId);
    const cleanup = (body.cleanup.steps ?? []).map((s) => s.cleanupStepId);
    return (
      new Set(steps).size === steps.length &&
      new Set(cleanup).size === cleanup.length
    );
  },
  { error: '用户提供的API内容不符合固定官方结构或步骤身份规则；未补造字段。' },
);
