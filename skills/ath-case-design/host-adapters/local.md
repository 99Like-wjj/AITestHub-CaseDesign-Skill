# 本地宿主适配

优先宿主已经配置且授权的 AITestHub 官方 MCP，运行时发现实际工具/Schema。凭据由宿主管理，不读 Key 文件、不要求贴到聊天、不在草稿/命令参数保存。不同客户端工具前缀可映射到相同真实 ath_* 名称，不能映射到任意 URL。

不需要安装本库就可按共享规则调用原生工具，但必须自行持久保存原稿/标识/原回执并遵守未知写规则。需要确定性协作时，由协调者注入 ToolPort.callTool，保留官方 SDK 原 CallToolResult envelope；本库不含鉴权、HTTP SDK、MRTR或网络重试。

WorkspacePort 用于库外受控目录保存 JSON 草稿/outbox，withExclusive 必须跨进程互斥，writeTextAtomic 必须在同目录原子替换。Node adapter 不跟随符号链接；异常退出遗留锁必须核实进程状态后由协调者处置，本库不自动抢锁再发请求。不要把运行目录指向此 repo、Skill 安装目录或参考 Skill。

没有可靠人机确认交互就保持等待，不能自动填 true。文件读取/登录原型所需浏览器由当前宿主权限控制；设计 Skill 不启动 Ego 或执行测试。接口/鉴权/安装未实测必须注明。
