import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CaseDesignError,
  type WorkspacePort,
  type ToolPort,
  type ResultPort,
} from './ports.js';
import {
  assetProjectionSchema,
  parseDraft,
  scenarioContentSchema,
  setContentSchema,
  uiContentSchema,
  uuidSchema,
  type AssetProjection,
  type Draft,
} from './schemas.js';
import {
  assertPublishedInput,
  assertPublishedAsset,
  providedApiContentSchema,
} from './published-contracts.js';

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined)
    throw new CaseDesignError('INVALID_JSON', '内容必须为JSON。');
  return result;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const stateSchema = z.enum([
  'prepared',
  'dispatching',
  'completed',
  'unknown',
  'waitingConfirmation',
  'failed',
  'cancelled',
]);
const entrySchema = z.strictObject({
  localId: z.string(),
  targetLocalId: z.string(),
  action: z.enum(['set', 'scenario', 'case', 'notes']),
  key: uuidSchema,
  state: stateSchema,
  reference: z.boolean(),
  payload: z.record(z.string(), z.unknown()).optional(),
  payloadDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  receipt: assetProjectionSchema.optional(),
  errorCode: z.string().max(100).optional(),
});
const outboxSchema = z.strictObject({
  schemaVersion: z.literal('ath.case-design.outbox.v2'),
  outboxId: uuidSchema,
  cancelRequested: z.boolean(),
  draft: z.unknown(),
  draftDigest: z.string().regex(/^[a-f0-9]{64}$/),
  apiSources: z.array(
    z.strictObject({
      localId: z.string(),
      sourceDescription: z.string(),
      sourceScenarioId: uuidSchema,
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  entries: z.array(entrySchema),
  deferred: z.array(
    z.strictObject({ localId: z.string(), reason: z.string() }),
  ),
});
export type Entry = z.infer<typeof entrySchema>;
export type Outbox = Omit<z.infer<typeof outboxSchema>, 'draft'> & {
  draft: Draft;
};
const keyFor = (id: string) => `outbox-${uuidSchema.parse(id)}.json`;
const cancelKeyFor = (id: string) => `cancel-${uuidSchema.parse(id)}.json`;

function plan(draft: Draft) {
  const entries: Pick<
    Entry,
    'localId' | 'targetLocalId' | 'action' | 'reference'
  >[] = [];
  const deferred: { localId: string; reason: string }[] = [];
  const blocked = new Set(
    draft.gaps
      .filter((g) => g.blocksSubmission)
      .flatMap((g) =>
        g.localIds.length
          ? g.localIds
          : [...draft.sets, ...draft.scenarios, ...draft.cases].map(
              (n) => n.localId,
            ),
      ),
  );
  const offer = (id: string, action: Entry['action'], parent?: string) => {
    if (blocked.has(id) || (parent && blocked.has(parent))) {
      blocked.add(id);
      deferred.push({ localId: id, reason: '资料缺口或父项尚不可提交' });
    } else {
      const n = [...draft.sets, ...draft.scenarios, ...draft.cases].find(
        (n) => n.localId === id,
      )!;
      entries.push({
        localId: id,
        targetLocalId: id,
        action,
        reference: 'existing' in n && n.existing?.action === 'reference',
      });
    }
  };
  for (const n of draft.sets) offer(n.localId, 'set');
  for (const n of draft.scenarios) offer(n.localId, 'scenario', n.setLocalId);
  for (const n of draft.cases) {
    if (n.kind === 'API' && n.readiness === 'proposal') {
      deferred.push({
        localId: n.localId,
        reason: `API业务提案未提交：${n.missing.join('；')}`,
      });
      blocked.add(n.localId);
    } else offer(n.localId, 'case', n.scenarioLocalId);
  }
  for (const n of draft.optimizationNotes) {
    if (blocked.has(n.assetLocalId))
      deferred.push({
        localId: n.localId,
        reason: '目标仍有阻止提交的资料缺口',
      });
    else
      entries.push({
        localId: n.localId,
        targetLocalId: n.assetLocalId,
        action: 'notes',
        reference: false,
      });
  }
  return { entries, deferred };
}
function parseOutbox(raw: string): Outbox {
  const input = outboxSchema.parse(JSON.parse(raw)),
    draft = parseDraft(input.draft);
  if (input.draftDigest !== digest(draft))
    throw new CaseDesignError('OUTBOX_INTEGRITY', '原稿摘要已改变；停止操作。');
  const expected = plan(draft);
  if (
    canonicalJson(
      input.entries.map(({ localId, targetLocalId, action, reference }) => ({
        localId,
        targetLocalId,
        action,
        reference,
      })),
    ) !== canonicalJson(expected.entries) ||
    canonicalJson(input.deferred) !== canonicalJson(expected.deferred) ||
    canonicalJson(input.apiSources) !== canonicalJson(apiSources(draft)) ||
    new Set(input.entries.map((e) => e.key)).size !== input.entries.length
  )
    throw new CaseDesignError('OUTBOX_INTEGRITY', '账本操作与固定草稿不一致。');
  for (const e of input.entries) {
    if (e.payload && e.payloadDigest !== digest(e.payload))
      throw new CaseDesignError('OUTBOX_INTEGRITY', '固定请求摘要已变化。');
    if (
      (e.state === 'prepared' && e.payload) ||
      (e.state === 'completed' && !e.receipt) ||
      ([
        'dispatching',
        'unknown',
        'waitingConfirmation',
        'completed',
        'failed',
      ].includes(e.state) &&
        !e.payload)
    )
      throw new CaseDesignError(
        'OUTBOX_INTEGRITY',
        '操作状态与持久请求/回执不一致。',
      );
  }
  return { ...input, draft };
}
function parentReceipt(box: Outbox, id: string): AssetProjection {
  const value = box.entries.find(
    (e) => e.targetLocalId === id && e.action !== 'notes',
  )?.receipt;
  if (!value)
    throw new CaseDesignError('PARENT_UNRESOLVED', '必须先取得真实父项回执。');
  return value;
}
function apiSources(draft: Draft): Outbox['apiSources'] {
  return draft.cases.flatMap((item) =>
    item.kind === 'API' && item.readiness === 'providedExecutable'
      ? [
          {
            localId: item.localId,
            sourceDescription: item.sourceDescription,
            sourceScenarioId: item.providedContent.scenarioId,
            contentDigest: digest(item.providedContent),
          },
        ]
      : [],
  );
}
function latestTargetReceipt(box: Outbox, id: string): AssetProjection {
  const receipt = box.entries
    .filter(
      (entry) => entry.targetLocalId === id && entry.state === 'completed',
    )
    .at(-1)?.receipt;
  if (!receipt)
    throw new CaseDesignError('PARENT_UNRESOLVED', '必须先取得真实目标回执。');
  return receipt;
}
function callFor(
  box: Outbox,
  e: Entry,
): {
  name: string;
  operation: string;
  args: Record<string, unknown>;
  expectedContent?: unknown;
} {
  const d = box.draft;
  if (e.action === 'notes') {
    const n = d.optimizationNotes.find((n) => n.localId === e.localId)!;
    const target = latestTargetReceipt(box, n.assetLocalId);
    const node = [...d.sets, ...d.scenarios, ...d.cases].find(
      (item) => item.localId === n.assetLocalId,
    )!;
    if (!('existing' in node) || !node.existing)
      throw new CaseDesignError('TARGET_UNRESOLVED', '优化目标没有固定基准。');
    const written = parentReceipt(box, n.assetLocalId);
    if (
      n.target === 'writtenRevision' &&
      (node.existing.action !== 'revise' ||
        written.revisionId === node.existing.baseRevisionId)
    )
      throw new CaseDesignError(
        'TARGET_UNRESOLVED',
        '没有可证明的本次实际写回修订。',
      );
    return {
      name: 'ath_reviews',
      operation: 'reviews.optimization-notes',
      args: {
        op: 'optimization-notes',
        projectId: d.projectId,
        id: target.id,
        input: {
          commandId: e.key,
          targetRevisionId:
            n.target === 'writtenRevision'
              ? written.revisionId
              : node.existing.baseRevisionId,
          rowVersion: target.rowVersion,
          notes: n.notes,
        },
      },
    };
  }
  const n = [...d.sets, ...d.scenarios, ...d.cases].find(
    (n) => n.localId === e.localId,
  )!;
  let content: unknown, parentId: string | undefined;
  if (e.action === 'set') {
    const set = d.sets.find((item) => item.localId === e.localId)!;
    content = setContentSchema.parse({
      title: set.title,
      basisRefs: set.basisRefs,
    });
  } else if (e.action === 'scenario') {
    const scenario = d.scenarios.find((s) => s.localId === e.localId)!;
    parentId = parentReceipt(box, scenario.setLocalId).id;
    content = scenarioContentSchema.parse({
      kind: d.kind,
      requirementVersionId: d.requirementVersionId,
      setId: parentId,
      title: scenario.title,
      objective: scenario.objective,
      sharedPreconditions: scenario.sharedPreconditions,
      basisRefs: scenario.basisRefs,
    });
  } else if (e.action === 'case') {
    const item = d.cases.find((c) => c.localId === e.localId);
    if (
      !item ||
      (item.kind === 'API' && item.readiness !== 'providedExecutable')
    )
      throw new CaseDesignError(
        'UNSUPPORTED_DRAFT',
        '资料不完整的API用例只保留提案。',
      );
    parentId = parentReceipt(box, item.scenarioLocalId).id;
    if (item.kind === 'UI' && !e.reference && !item.steps?.length)
      throw new CaseDesignError(
        'VALIDATION_ERROR',
        '新建或修订 UI 用例需要明确的文字业务步骤。',
      );
    content =
      item.kind === 'API'
        ? providedApiContentSchema.parse({
            ...item.providedContent,
            scenarioId: parentId,
          })
        : uiContentSchema.parse({
            kind: 'UI',
            scenarioId: parentId,
            title: item.title,
            testPoint: item.testPoint,
            preconditions: item.preconditions,
            ...(item.steps ? { steps: item.steps } : {}),
            expected: item.expected,
            basisRefs: item.basisRefs,
          });
  } else
    throw new CaseDesignError('UNSUPPORTED_DRAFT', '没有可提交的正式内容。');
  if ('existing' in n && n.existing) {
    if (n.existing.action === 'reference')
      return {
        name: 'ath_assets',
        operation: 'assets.get-reference',
        expectedContent: content,
        args: { op: 'get', projectId: d.projectId, id: n.existing.id },
      };
    return {
      name: 'ath_assets',
      operation: 'assets.revise',
      expectedContent: content,
      args: {
        op: 'revise',
        projectId: d.projectId,
        id: n.existing.id,
        input: {
          commandId: e.key,
          baseRevisionId: n.existing.baseRevisionId,
          rowVersion: n.existing.rowVersion,
          content,
        },
      },
    };
  }
  const op = `create-${e.action}`;
  const base = { commandId: e.key, content };
  const input =
    e.action === 'set'
      ? { ...base, kind: d.kind, requirementVersionId: d.requirementVersionId }
      : e.action === 'scenario'
        ? { ...base, setId: parentId }
        : { ...base, scenarioId: parentId };
  return {
    name: 'ath_assets',
    operation: `assets.${op}`,
    expectedContent: content,
    args: { op, projectId: d.projectId, input },
  };
}
function accept(box: Outbox, e: Entry, data: unknown): void {
  const rawAsset = z.object({ asset: z.unknown() }).parse(data).asset;
  assertPublishedAsset(rawAsset);
  const parsed = z.object({ asset: assetProjectionSchema }).parse(data),
    a = parsed.asset,
    d = box.draft;
  const expected = callFor(box, e);
  const node = [...d.sets, ...d.scenarios, ...d.cases].find(
    (n) => n.localId === e.targetLocalId,
  );
  const expectedId =
    e.action === 'notes'
      ? parentReceipt(box, e.targetLocalId).id
      : node && 'existing' in node
        ? node.existing?.id
        : undefined;
  const target =
    e.action === 'notes'
      ? parentReceipt(box, e.targetLocalId).targetType
      : e.action;
  const parent =
    e.action === 'scenario'
      ? parentReceipt(
          box,
          d.scenarios.find((s) => s.localId === e.localId)!.setLocalId,
        )
      : e.action === 'case'
        ? parentReceipt(
            box,
            d.cases.find((c) => c.localId === e.localId)!.scenarioLocalId,
          )
        : undefined;
  if (
    a.projectId !== d.projectId ||
    a.kind !== d.kind ||
    a.requirementVersionId !== d.requirementVersionId ||
    a.targetType !== target ||
    (expectedId && a.id !== expectedId) ||
    (parent && (a.parentId !== parent.id || a.setId !== parent.setId)) ||
    (a.targetType === 'set' && (a.parentId !== null || a.setId !== a.id)) ||
    (e.action !== 'notes' &&
      canonicalJson(a.content) !== canonicalJson(expected.expectedContent)) ||
    (e.reference &&
      node &&
      'existing' in node &&
      node.existing &&
      (a.revisionId !== node.existing.baseRevisionId ||
        a.rowVersion !== node.existing.rowVersion))
  )
    throw new CaseDesignError(
      'RECEIPT_MISMATCH',
      '回执归属、层级、内容或正式身份不匹配；仅查原操作。',
    );
  if (
    e.action === 'notes' &&
    z.object({ approvalCreated: z.literal(false) }).safeParse(data).success ===
      false
  )
    throw new CaseDesignError(
      'RECEIPT_MISMATCH',
      '处理说明回执未明确声明未批准。',
    );
  if (e.action === 'notes') {
    const prior = latestTargetReceipt(box, e.targetLocalId);
    const targetRevisionId = z
      .object({ input: z.object({ targetRevisionId: uuidSchema }) })
      .parse(expected.args).input.targetRevisionId;
    const currentTarget = prior.revisionId === targetRevisionId;
    if (
      a.revisionId !== prior.revisionId ||
      a.revisionNo !== prior.revisionNo ||
      canonicalJson(a.content) !== canonicalJson(prior.content) ||
      a.rowVersion < prior.rowVersion ||
      (currentTarget
        ? a.reviewState !== 'aiOptimized' || a.rowVersion === prior.rowVersion
        : a.reviewState !== prior.reviewState ||
          a.rowVersion !== prior.rowVersion)
    )
      throw new CaseDesignError(
        'RECEIPT_MISMATCH',
        '说明回执未保持真实当前修订、内容和处理状态；仅查原操作。',
      );
  } else if (
    !e.reference &&
    (a.reviewState !== 'pending' ||
      (node &&
        'existing' in node &&
        node.existing &&
        (a.revisionId === node.existing.baseRevisionId ||
          a.rowVersion <= node.existing.rowVersion)))
  ) {
    throw new CaseDesignError(
      'RECEIPT_MISMATCH',
      '写回没有形成新的待审修订；不能据此标记优化完成。',
    );
  }
  e.receipt = a;
  e.state = 'completed';
  delete e.errorCode;
}
function isWaiting(data: unknown): boolean {
  return (
    z.object({ status: z.literal('waitingConfirmation') }).safeParse(data)
      .success ||
    z
      .object({
        confirmation: z.object({ status: z.literal('waitingConfirmation') }),
      })
      .safeParse(data).success
  );
}
export class CaseDesignWorkflow {
  constructor(
    readonly tools: ToolPort,
    readonly workspace: WorkspacePort,
    readonly results: ResultPort,
  ) {}
  async prepare(
    raw: unknown,
    outboxId: string = randomUUID(),
  ): Promise<Outbox> {
    this.results.assertSafe(raw);
    const draft = parseDraft(raw),
      key = keyFor(outboxId);
    return this.workspace.withExclusive(key, async () => {
      const prior = await this.workspace.readText(key);
      if (prior) {
        const box = parseOutbox(prior);
        if (box.outboxId !== outboxId)
          throw new CaseDesignError(
            'OUTBOX_INTEGRITY',
            '账本身份与文件名不符。',
          );
        if (box.draftDigest !== digest(draft))
          throw new CaseDesignError(
            'OUTBOX_CONFLICT',
            '同账本标识不能写入不同草稿。',
          );
        return box;
      }
      const p = plan(draft),
        box: Outbox = {
          schemaVersion: 'ath.case-design.outbox.v2',
          outboxId,
          cancelRequested: false,
          draft,
          draftDigest: digest(draft),
          apiSources: apiSources(draft),
          entries: p.entries.map((e) => ({
            ...e,
            key: randomUUID(),
            state: 'prepared',
          })),
          deferred: p.deferred,
        };
      await this.workspace.writeTextAtomic(key, canonicalJson(box));
      return box;
    });
  }
  async read(outboxId: string): Promise<Outbox> {
    const raw = await this.workspace.readText(keyFor(outboxId));
    if (raw === null)
      throw new CaseDesignError('OUTBOX_NOT_FOUND', '没有原账本。');
    const box = parseOutbox(raw);
    if (box.outboxId !== outboxId)
      throw new CaseDesignError('OUTBOX_INTEGRITY', '账本身份与文件名不符。');
    this.results.assertSafe(box);
    await this.applyCancellation(box);
    return box;
  }
  private async applyCancellation(box: Outbox): Promise<void> {
    const marker = await this.workspace.readText(cancelKeyFor(box.outboxId));
    if (marker !== null) {
      const request = z
        .strictObject({ outboxId: uuidSchema })
        .parse(JSON.parse(marker));
      if (request.outboxId !== box.outboxId)
        throw new CaseDesignError('OUTBOX_INTEGRITY', '取消意图身份不符。');
      box.cancelRequested = true;
    }
    if (box.cancelRequested)
      for (const entry of box.entries)
        if (entry.state === 'prepared') entry.state = 'cancelled';
  }
  async dispatch(outboxId: string): Promise<Outbox> {
    const key = keyFor(outboxId);
    return this.workspace.withExclusive(key, async () => {
      const box = await this.read(outboxId);
      for (const e of box.entries) {
        await this.applyCancellation(box);
        if (box.cancelRequested)
          await this.workspace.writeTextAtomic(key, canonicalJson(box));
        if (e.state === 'dispatching') {
          e.state = 'unknown';
          e.errorCode = 'INTERRUPTED_DISPATCH';
          await this.workspace.writeTextAtomic(key, canonicalJson(box));
        }
        if (e.state !== 'completed' && e.state !== 'prepared') return box;
        if (e.state === 'completed') continue;
        const call = callFor(box, e);
        if (e.payload && canonicalJson(e.payload) !== canonicalJson(call.args))
          throw new CaseDesignError(
            'OUTBOX_INTEGRITY',
            '固定payload与草稿/真实父项不符。',
          );
        this.results.assertSafe(call.args);
        assertPublishedInput(call.name, call.args);
        e.payload = call.args;
        e.payloadDigest = digest(call.args);
        e.state = 'dispatching';
        await this.workspace.writeTextAtomic(key, canonicalJson(box));
        try {
          const result = this.results.read(
            await this.tools.callTool(call.name, call.args),
          );
          this.results.assertSafe(result);
          if (isWaiting(result)) e.state = 'waitingConfirmation';
          else accept(box, e, result);
        } catch (error) {
          const failure = z
            .object({
              certainty: z.enum(['notDispatched', 'knownFailed', 'unknown']),
              code: z.string().regex(/^[A-Z0-9_]{1,100}$/),
            })
            .safeParse(error);
          e.state =
            failure.success && failure.data.certainty !== 'unknown'
              ? 'failed'
              : 'unknown';
          e.errorCode = failure.success
            ? failure.data.code
            : 'DISPATCH_RESULT_UNKNOWN';
        }
        await this.workspace.writeTextAtomic(key, canonicalJson(box));
        if (!['completed'].includes(e.state)) return box;
      }
      return box;
    });
  }
  /** Read-only against the remote platform: never dispatches or retries a business write. */
  async recover(outboxId: string): Promise<Outbox> {
    const key = keyFor(outboxId);
    return this.workspace.withExclusive(key, async () => {
      const box = await this.read(outboxId);
      for (const e of box.entries) {
        if (
          !['dispatching', 'unknown', 'waitingConfirmation'].includes(e.state)
        )
          continue;
        const call = callFor(box, e);
        try {
          const toolName = e.reference ? call.name : 'ath_operation_status',
            args = e.reference
              ? call.args
              : { op: 'get', operation: call.operation, key: e.key };
          assertPublishedInput(toolName, args);
          const result = this.results.read(
            await this.tools.callTool(toolName, args),
          );
          this.results.assertSafe(result);
          if (e.reference) accept(box, e, result);
          else if (!isWaiting(result)) {
            const receipt = z
              .object({
                command: z.object({
                  operation: z.string(),
                  projectId: uuidSchema.nullable(),
                  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
                  response: z.unknown().nullable(),
                }),
              })
              .parse(result).command;
            if (
              receipt.operation !== call.operation ||
              receipt.projectId !== box.draft.projectId
            )
              throw new CaseDesignError(
                'RECEIPT_MISMATCH',
                '原操作类型不匹配。',
              );
            if (receipt.status === 'completed' && receipt.response !== null)
              accept(box, e, receipt.response);
            else {
              e.state = 'unknown';
              e.errorCode = 'ORIGINAL_OPERATION_UNRESOLVED';
            }
          } else {
            e.state = 'waitingConfirmation';
            e.errorCode = 'ORIGINAL_OPERATION_UNRESOLVED';
          }
        } catch {
          e.state = 'unknown';
          e.errorCode = 'ORIGINAL_LOOKUP_UNRESOLVED';
        }
        await this.workspace.writeTextAtomic(key, canonicalJson(box));
      }
      return box;
    });
  }
  async cancel(outboxId: string): Promise<Outbox> {
    const key = keyFor(outboxId);
    // A separate atomic intent must be visible while the dispatch lock spans an in-flight call.
    await this.read(outboxId);
    await this.workspace.writeTextAtomic(
      cancelKeyFor(outboxId),
      canonicalJson({ outboxId }),
    );
    try {
      return await this.workspace.withExclusive(key, async () => {
        const box = await this.read(outboxId);
        await this.workspace.writeTextAtomic(key, canonicalJson(box));
        return box;
      });
    } catch (error) {
      if (z.object({ code: z.literal('STORE_BUSY') }).safeParse(error).success)
        return this.read(outboxId);
      throw error;
    }
  }
}
