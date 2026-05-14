# 💡我该选哪个？
不需要全部都配置，选择一个最适合你的就可以了

1. [KIE](https://kie.ai?ref=eef20ef0b0595cad227d45b29c635f6c)：价格和稳定性都还不错，国内用户可以去[账单](https://kie.ai/zh-CN/billing)页面申请一些优惠
2. [派欧云](https://ppio.com/user/register?invited_by=WGY0DZ)：价格没啥优惠，但是比较稳定，该供应商仅支持 Nano Banana 2
3. [fal](https://fal.ai)：比较适合国外用户，价格没啥优惠，但胜在稳定正规
4. [GRSAI](https://grsai.com)：虽然价格便宜，但是不太稳定，如果一直报错，建议使用别的供应商，注意接入点的区别，不是所有接入点都便宜

---

# 💡我该怎么做？

1. 打开网站，注册一下
2. 找到 API 密钥（API KEY）管理页面
3. 创建并复制密钥
4. 将密钥填写到对应的供应商下面
5. 开始用吧！

---

# 666API 密钥分组说明

666API 的密钥按令牌分组，不同模型需要使用对应分组的 key：

| 分组 | 适用模型 | 配置项 |
|------|---------|--------|
| claude | Claude 系列模型 | 666API Claude Key |
| gpt | GPT 系列模型 | 666API GPT Key |
| gemini | Gemini 系列模型（含绘图） | 666API Gemini Key |
| default | 其他所有模型（doubao、qwen 等） | 666API Default Key |

程序会根据所选模型自动选择对应分组的 key，无需手动切换。如果某个分组未配置 key，会回退使用 default 分组的 key。

---

# 巨游API（备用方案）

巨游API 是与 666API 完全相同协议的统一大模型网关，作为备用方案接入。

配置步骤：
1. 在「域名 / 接口地址」输入框填写巨游API 的 base URL（如 `https://api.juyou.ai`）
2. 按与 666API 相同的分组方式配置各组密钥

密钥分组与 666API 一致（claude / gpt / gemini / default）。巨游API 的模型在模型下拉框中会标注"巨游"后缀以区分。

---

# Ollama（本地部署）

Ollama 用于接入本地部署的大语言模型，适合对隐私有要求或希望使用本地模型的用户。

配置步骤：
1. 确保本地已运行 Ollama 服务（或局域网内可访问的 Ollama 实例）
2. 在「API 地址」输入框填写 Ollama 的 OpenAI 兼容端点（如 `http://localhost:11434` 或 `http://192.168.x.x:11434`）
   - 注意：只填写到端口号即可，不要加 `/v1` 后缀，程序会自动拼接
3. 在「密钥」输入框填写认证密钥（如果 Ollama 未启用认证，可随意填写）
4. 在「模型名称」输入框填写要使用的模型名称（如 `gemma4:e4b`），须与 `ollama list` 中显示的名称一致

支持的模型：任何 Ollama 已拉取的多模态模型均可使用，但实际效果取决于模型能力。

---

# AI 助手配置

反推提示词和 Prompt 工程师功能使用独立的 AI 助手服务商配置，不影响图片生成。

配置方式：
1. 在「设置 → 服务商标签页」顶部找到「AI 助手服务商」区域
2. 从下拉框选择服务商（666API / 巨游API / Ollama）
3. 在「模型名称」输入框填写该服务商下可用的模型名称

各服务商示例：
- 666API：`doubao-seed-2-0-mini-260215`（默认）、`gpt-4o` 等
- 巨游API：`gpt-5.2` 等巨游API 支持的模型
- Ollama：`gemma4:e4b` 等本地已拉取的模型

不填写模型名称时，默认使用 `doubao-seed-2-0-mini-260215`。
