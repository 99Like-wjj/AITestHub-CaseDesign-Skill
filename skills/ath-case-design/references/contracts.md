# 业务契约与提交

兼容快照：ath.contracts.v1，ath.asset-changes.v1，2026-11-13 当前平台 Schema。工具须实际可用；本文件不是 MCP 客户端实现。宿主工具命名由 adapter 映射，不设任意 HTTP/SQL 通道。

- `ath_assets/list`：`{op:'list',projectId,input:{kind,requirementVersionId?,setId?,includeRemoved?,includeArchivedRequirements?}}`。
- `ath_assets/get`：`{op:'get',projectId,id}`，读取 asset 及修订。
- `create-set`：`{op,projectId,input:{commandId,kind,requirementVersionId,content:{title,basisRefs}}}`。
- `create-scenario`：input 有 commandId/setId/content；content 含 kind/requirementVersionId/setId/title/objective/sharedPreconditions/basisRefs。
- `create-case`：input 有 commandId/scenarioId/content；UI content 含 kind:'UI'/scenarioId/title/testPoint/preconditions/steps/expected/basisRefs。steps 按业务顺序，每步包含非空 action，以及可选的 expected。历史读取可能没有 steps，正式写入新建或修订时须提供。
- `revise`：`{op:'revise',projectId,id,input:{commandId,baseRevisionId,rowVersion,content}}`，生成不可变新修订。
- `submit`：input 为 ath.asset-changes.v1，submissionId、kind、projectId、requirementVersionId、mode、operations、baseRevisionMap；逐项 accepted/rejected，absenceDeletes:false。

不调用虚构的 ath_assets.prepare/commit/receipt。本版 helper 用 create-set→create-scenario→create-case 顺序：依靠实际回执 ID 形成子项 payload，不在严格 UUID 内容字段塞 localId/假 UUID。修改保留真实 ID 和原 revision/rowVersion。API 内容必须符合固定官方 Schema，缺资料只能 proposal。

0.1.1 使用 `ath.case-design.draft.v2`/`ath.case-design.outbox.v2`，不默默解释旧版本账本。未结束的旧任务用保留的 0.1.0 原包恢复，不能向新 helper 换 ID 重发旧未知写。API 草稿二选一：`readiness:'proposal'` 保留业务字段和非空 missing；或 `readiness:'providedExecutable'`，带完整 `providedContent`、`sourceDescription` 和显式 `parentMapping:'selectedScenario'`。providedContent 必须包含原 scenarioId、dslVersion、variables、steps、cleanup 及官方要求字段。仅真实父回执 scenarioId 替换进入待审写入，其余完整保留；sourceScenarioId、来源说明和规范 JSON 摘要另存 outbox.apiSources。该摘要不是用户原文件字节 hash，也不是外发许可证明。空 assertions 是可保存的草稿，不擅自加 status200；服务端执行资格和批准另判。

结构快照由 hash 校验的开发导入器从 `4fd2daf7-e5e4-493d-90ac-53ad642cc09e` 复制，包含真实 apiCaseContentSchema。运行时不跨仓 import、不动态拉 Schema；不运行用户提供的 SQL/script/URL。JSON Schema 结构不能取代服务端 refine/权限/CAS；本地另核 stepId/cleanupStepId 唯一。秘密拒绝由宿主 ResultPort 在落盘/发送前执行，不把秘密藏进 DSL。

已有草稿节点的 existing 必须带 action:reference/revise。reference 只 GET 并核对原 revision/rowVersion/内容与归属，不为整理子用例无谓改写父级；revise 才写新修订。修改父级可能令子项评审/行基准变化，应读取实际新上下文并比较，不让工具自动把新基准套到旧草稿。UI 内容的未知字段严格拒绝，不先丢字段再提交。

先把版本化草稿、固定提交标识、payload 和 dispatching 状态写入库外 outbox，随后仅发一次。回执验证项目、kind、需求版本、层级和对象 ID；读实际 reviewState，不推断成功。已完成项不重复提交；局部失败不伪装全成。

任何断线、未知、非法回执或进程崩溃留下的 dispatching 只允许 `ath_operation_status/get`：`{op:'get',operation:'assets.create-case'或实际operation,key:原commandId}`。`submission` op 是结果提交，不用来查询资产。查不到并不能证明未发，仍 unknown；不换 key 或自动重试。真正收到原结果并核对后才恢复后续。取消仅阻止未发项，不声称回滚已完成写。

文件字节不进 MCP/model；已配置安全传输通道时使用正式文件登记和完整 PUT 验证。库里不保存 Key、Cookie、Token、内部业务运行资料。本项目 WorkspacePort 只保存业务草稿/outbox，不接管平台文件上传或身份认证。
