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
