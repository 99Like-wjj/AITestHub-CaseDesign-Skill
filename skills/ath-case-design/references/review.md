# 意见与修订

## 独立会议评审

当用户给出会议交接 ID 时，调用已配置的官方 MCP 中 ath_reviews 的 meeting-handoff，参数为 op、projectId、id（会议 ID）。只处理返回的明确意见、caseId 及轮次。同一用例涉及多条意见时，先合并考虑目标的修改范围，一次基于该用例的当前基准生成修订。保留基准发送前的实际读回和确切意见。若 baseChanged 为真，说明存在可能已写入的调整，先读原操作回执，只有原提交确实产生了待回应的修订时才关联该修订，其余情况由测试人员按当前基准补发意见。

真实修订沿 ath_assets revise 或 submit 写回后，按每个意见和用例分别调用 ath_reviews meeting-reply。外层传 op、projectId、id，输入传 commandId、caseId、opinionId、round、baseRevisionId、实际 revisionId、outcome 和 body。outcome 取 changed、retained 或 unaddressed，须说明变动、保留理由或实际缺口。保留原 commandId，未知结果使用 ath_operation_status 查询 reviews.meeting-reply 原回执。测试人员在 Web 复审并逐条批准。

## 既有资产意见

逐层用 `ath_reviews/opinions` 读明确 projectId/id/revisionId，检查 currentRevisionId/isCurrentRevision；意见可能来自批次、场景、用例。每条原意见 ID 给短说明：改了什么、哪个新增用例回应、尚未处理或所缺资料。不能将待澄清包装成“已解决”，也不自动沉淀永久知识。

`ath_reviews/optimization-notes` 真实 32 输入为 `{op,projectId,id,input:{commandId,targetRevisionId,rowVersion,notes:[{opinionId,sourceOpinionRevisionId,note}]}}`。sourceOpinionRevisionId 明确保留原意见来源；targetRevisionId 是本次处理的目标修订，可以是后续实际写回修订，不移动或删除原意见。跨修订必须来源早于目标、目标为当前修订且携带当前 CAS，服务端最终校验。返回 approvalCreated:false，不等于批准。

草稿说明必须明确 `target:'writtenRevision'|'baseRevision'`，每条携带 sourceOpinionRevisionId 和原 opinionId。writtenRevision 只用于对应节点有实际 revise 的情况：先确认 revise 返回真实新 revisionId，再用它作目标，不能由模型猜 r2 UUID。rowVersion 取最近一次已确认的同资产回执；连续说明也依前条真实回执，不自增猜基准。baseRevision 只给固定原基准写历史说明，不能称它优化了新修订。保留所有已处理/未处理的解释文字；不以改写、漏写未处理项来声称意见已关闭。

写回先产生 pending，当前目标的说明成功后读实际 aiOptimized；两个阶段各存原请求/回执。接受说明回执时核实当前修订/内容不漂移及 approvalCreated:false。旧目标说明不改变当前新修订的 pending。CAS 冲突不自动读取新基准套旧稿，先保留冲突；unknown 仅查原 nested command，不换 ID 重写。真实 32/MCP/模型联调仍须独立验收，本地合成 port 通过不作联通证明。

S01 不自动使用 remove-opinion/preview-approve/approve。人工在平台核对当前内容与上层条件；新草稿不改写旧已审 API 快照。新资料版本不能沿用旧批准，不能靠复制新批次绕过上层待审问题。
