import { z } from 'zod';
import snapshot from './published-contracts.json' with { type: 'json' };
import currentApi from './api-content.contract.json' with { type: 'json' };
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
const apiContract = z.record(z.string(), z.unknown()).parse(currentApi.schema);
const apiDefs = z.record(z.string(), z.unknown()).parse(apiContract.$defs);
const apiReferencePrefix = 'currentApiContent_';

function namespaceApiReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(namespaceApiReferences);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [
      key,
      key === '$ref' && typeof part === 'string' && part.startsWith('#/$defs/')
        ? `#/$defs/${apiReferencePrefix}${part.slice('#/$defs/'.length)}`
        : namespaceApiReferences(part),
    ]),
  );
}
const namespacedApiDefs = Object.fromEntries(
  Object.entries(apiDefs).map(([key, value]) => [
    `${apiReferencePrefix}${key}`,
    namespaceApiReferences(value),
  ]),
);
const apiLeaf = namespaceApiReferences(
  Object.fromEntries(
    Object.entries(apiContract).filter(
      ([key]) => key !== '$schema' && key !== '$defs',
    ),
  ),
);
const apiContentMarker = z.object({
  properties: z.object({
    kind: z.object({ const: z.literal('API') }),
    dslVersion: z.object({ const: z.literal('ath.api-case.v1') }),
  }),
});
function currentApiLeaves(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(currentApiLeaves);
  if (!value || typeof value !== 'object') return value;
  if (apiContentMarker.safeParse(value).success) return apiLeaf;
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [key, currentApiLeaves(part)]),
  );
}
function currentSchema(raw: unknown) {
  const projected = z
    .record(z.string(), z.unknown())
    .parse(currentApiLeaves(raw));
  const defs = z.record(z.string(), z.unknown()).parse(projected.$defs ?? {});
  return z.fromJSONSchema({
    ...projected,
    $defs: { ...defs, ...namespacedApiDefs },
  } as Parameters<typeof z.fromJSONSchema>[0]);
}
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
const asset = currentSchema(snapshot.components['assets.assetSchema']);
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
      currentSchema({
        ...branch,
        ...(root.$defs ? { $defs: root.$defs } : {}),
      }),
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
  dataRows?: { id: string; name: string; values: Record<string, unknown> }[];
  preparations?: {
    caseId: string;
    revisionId: string;
    parameters: Record<string, unknown>;
  }[];
  steps: {
    stepId: string;
    extractors: { name: string; sensitive?: boolean; [key: string]: unknown }[];
    [key: string]: unknown;
  }[];
  cleanup: {
    mode: string;
    steps?: { cleanupStepId: string; [key: string]: unknown }[];
  };
  [key: string]: unknown;
}
const publishedApi = z.fromJSONSchema(
  currentApi.schema as Parameters<typeof z.fromJSONSchema>[0],
);
// Validation only: preserve the user's complete content, without defaults or stripping.
export const providedApiContentSchema = z.custom<ApiCaseContent>(
  (value) => {
    if (!publishedApi.safeParse(value).success) return false;
    const body = value as ApiCaseContent;
    const steps = body.steps.map((s) => s.stepId);
    const cleanup = (body.cleanup.steps ?? []).map((s) => s.cleanupStepId);
    const rows = body.dataRows ?? [];
    return (
      new Set(steps).size === steps.length &&
      new Set(cleanup).size === cleanup.length &&
      new Set(rows.map((row) => row.id)).size === rows.length &&
      rows.every(
        (row) => row.name.trim().length > 0 && row.name.trim().length <= 120,
      )
    );
  },
  { error: '用户提供的API内容不符合固定官方结构或步骤身份规则；未补造字段。' },
);
