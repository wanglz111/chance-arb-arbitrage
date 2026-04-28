# 候选发现扫描器架构说明

## 1. 项目目标

这个项目的第一阶段目标不是“自动套利执行”，而是“候选发现”：

- 从 Arbitrum 链上持续筛出值得继续研究的交易
- 给每笔可疑交易打上统一标签
- 输出足够好的证据，方便后续做 replay、模拟和协议特化研究

这里的“候选”不是利润结论，而是：

- 这笔交易可能包含套利结构
- 这笔交易可能暴露了一个状态型机会
- 这笔交易可能代表一个还没被系统化覆盖的市场

一句话说：先把“值得研究的交易”从海量链上活动里捞出来。

## 2. 这阶段明确不做什么

为了避免项目一开始就复杂度失控，第一阶段不做这些事情：

- 不直接发单
- 不做自动抢跑
- 不做收益证明
- 不做复杂的 gas 优化
- 不做精确的 PnL 结算
- 不把每条候选都强行解释成“确定套利”

这一步只解决一个核心问题：

“哪些交易值得继续追，为什么值得追？”

## 3. 为什么先做候选发现

如果一开始就追求执行，工程会被这些问题拖住：

- 排序和延迟
- nonce 管理
- gas 与广播链路
- 成功率和回滚
- 针对单个机会的特化实现

但我们现在真正缺的，其实不是执行器，而是：

- 一套稳定的候选发现框架
- 一套统一的标签语言
- 一套能持续沉淀新机会类型的研究入口

先做 discovery 的好处：

1. 能快速积累样本
2. 能验证哪些标签真的有价值
3. 能把“看起来像机会”和“真的值得做”分开
4. 后面扩 replay 和 executor 时，方向更清楚

## 4. 第一阶段要覆盖的候选标签

### 4.1 `flash-loan`

定义：

- 交易里出现明确的 flash loan 事件
- 或者出现已知 flash-loan 路径的组合痕迹

价值：

- 很多真正的套利、清算、去杠杆交易都以 flash loan 为资金入口
- 即使这笔交易不一定能复制，它也常常能暴露“哪里存在结构性价差”

第一版判定方式：

- 直接识别 Aave V3 `FlashLoan` 事件
- 后续再补其他协议的 flash loan 事件和 callback 规则

### 4.2 `multi-pool-swap`

定义：

- 同一笔交易中出现多个 swap 池地址
- 或出现一条明显的多跳交换路径

价值：

- 多池路径常常意味着聚合器最优路由
- 也可能意味着跨池搬砖、份额 token 退出、清算后的再平衡

第一版判定方式：

- 统计交易回执里的 V2/V3 类 `Swap` 事件
- 唯一池地址数量达到阈值时打标签

### 4.3 `wrap-unwrap-redeem`

定义：

- 同一笔交易里同时出现 `WETH Deposit/Withdrawal`
- 并伴随 vault/aToken/Aave withdraw 一类“赎回式”行为

价值：

- 这类结构经常出现在“份额资产 -> 底层资产 -> 原生 ETH”路径里
- 它往往不长得像经典双池套利，但可能暴露折价赎回机会

第一版判定方式：

- 识别 `WETH` 的 `Deposit` / `Withdrawal`
- 与 Aave `Withdraw`、ERC4626 `Withdraw`、监控 share pair 的 token 流一起看

### 4.4 `reserve-liquidity-shift`

定义：

- 某个被监控 reserve 的可用流动性发生显著变化
- 特别是 `Supply` / `Repay` 带来的正向补流动性

价值：

- 这类事件和你当前的 aArbWETH 项目直接相关
- 它不是“价格套利”，而是“状态变化触发的可兑付窗口”

第一版判定方式：

- 监听 Aave V3 的 `Supply`、`Repay`、`Withdraw`、`Borrow`
- 对被监控 reserve 计算正向/负向流动性变化
- 当正向变化超过阈值时输出候选

### 4.5 `vault-share-discount-redeem`

定义：

- 某个 share token / aToken 和底层 token 在同一交易内同时被触发
- 并且行为更像“折价退出”或“份额换底层”而不是普通转账

价值：

- 这类机会是最容易被传统 price-arb 视角漏掉的
- 它更像资产结构和赎回路径上的错配

第一版判定方式：

- 允许配置若干 `shareToken -> underlyingToken` 监控对
- 若一笔交易同时触发 share token 和 underlying token 的相关 transfer/swap/redeem 痕迹，则打标签

### 4.6 `liquidation-deleverage-imbalance`

定义：

- 清算、去杠杆或还债路径导致局部状态突变
- 并可能在同块或后续几块里暴露可利用窗口

价值：

- 很多“非寻常机会”都藏在 liquidation / deleverage 的尾部状态里
- 表面看不是套利，实质是异常状态修复

第一版判定方式：

- 识别 Aave `LiquidationCall`
- 或识别 `flash loan + repay + withdraw`
- 或识别 `repay + withdraw + multi-pool-swap` 的复合路径

## 5. 技术路线

### 5.1 技术栈

第一版建议：

- 语言：TypeScript
- 链接库：`ethers`
- 配置：`dotenv`
- 输出：终端 + `jsonl`

原因：

- 你的现有项目已经在 TypeScript / ethers 上积累了很多经验
- 第一阶段不是高频执行器，不需要为了极限性能增加复杂度
- TypeScript 在“解析交易、打标签、沉淀规则”这件事上成本最低

### 5.2 数据源策略

第一阶段优先用 `HTTP RPC + block polling`，而不是一上来做复杂的 feed / pending 系统。

原因：

- 现在目标是候选发现，不是亚秒级执行
- 先把分类和标签系统做好，比先优化链路更重要
- 轮询新区块拿整块交易和回执，已经足够做 discovery

建议的数据获取方式：

1. 轮询最新块号
2. 获取整块交易
3. 获取整块回执
4. 对每笔交易做分类

可选优化：

- 如果 RPC 支持 `eth_getBlockReceipts`，优先走这个
- 如果不支持，再回退到按交易逐笔拉 receipt

### 5.3 为什么第一版不优先做 WS / pending / sequencer feed

这些能力当然有价值，但它们更适合第二阶段：

- 当你已经知道哪些候选最值得抢
- 当你已经有稳定标签和 replay 验证链路
- 当你确定要从 discovery 走向实时利用

第一阶段先把“发现准确率”和“研究效率”做出来。

## 6. 核心处理流程

### 6.1 输入层

输入模式分三种：

1. `live scan`
   扫描最新区块

2. `block backfill`
   回扫指定区块范围

3. `single tx analyze`
   单独分析一笔给定交易

### 6.2 归一化层

对每笔交易提取统一信号：

- swap 事件数量
- swap 池地址集合
- flash loan 事件
- Aave 相关事件
- WETH wrap / unwrap
- ERC4626 withdraw / deposit
- 监控 token pair 的 transfer 痕迹

这一步的重点不是“完整解释交易”，而是把不同协议的活动压成统一特征。

### 6.3 标签层

对统一特征做规则判断，输出：

- 标签列表
- 证据列表
- 协议列表
- 分数

分数不是利润，而是“值得继续研究的优先级”。

### 6.4 输出层

每条候选都输出为结构化结果：

- `txHash`
- `blockNumber`
- `tags`
- `score`
- `summary`
- `evidence`
- `protocols`
- 一些核心统计值

输出同时写到：

- 终端日志
- `jsonl` 文件

这样后面可以：

- grep
- 做批量统计
- 复盘某类标签
- 选样本做 replay

## 7. 推荐的模块拆分

### 7.1 `config`

负责：

- RPC 配置
- 轮询间隔
- 分数阈值
- reserve 白名单
- share pair 白名单

### 7.2 `constants`

负责：

- 关键地址
- 事件签名
- 最小 ABI

### 7.3 `fetcher`

负责：

- 获取区块
- 获取交易
- 获取回执
- block receipts 能力探测与回退

### 7.4 `classifier`

负责：

- 从 receipt/log 中提取统一信号
- 做标签判断
- 产出候选对象

这是第一阶段最核心的模块。

### 7.5 `reporter`

负责：

- 控制台输出
- 文件落盘
- 后续也可以扩成 sqlite 或 clickhouse

### 7.6 `service/scanner`

负责：

- live 模式的循环扫描
- backfill 模式
- 单笔交易分析入口

## 8. 标签实现方法细化

### 8.1 `flash-loan`

第一版：

- 明确识别 Aave `FlashLoan`
- 累积金额
- 超过阈值则打标签

后续增强：

- 接 Balancer / Uniswap flash
- 接 protocol-specific callback 模式

### 8.2 `multi-pool-swap`

第一版：

- 识别 V2-like / V3-like `Swap`
- 统计不同池地址数量

后续增强：

- 识别更多 AMM 协议
- 结合 token path 重建大致路由

### 8.3 `wrap-unwrap-redeem`

第一版：

- 识别 WETH `Deposit` / `Withdrawal`
- 与 Aave `Withdraw`、ERC4626 `Withdraw`、share pair 触发做组合判断

后续增强：

- 补 native ETH / WETH 进出流的净额对比
- 识别 router 内嵌 unwrap 路径

### 8.4 `reserve-liquidity-shift`

第一版：

- 对被监控 reserve 汇总：
  - `Supply`
  - `Repay`
  - `Withdraw`
  - `Borrow`

- 计算：
  - `reserveShiftUp`
  - `reserveShiftDown`

后续增强：

- 补更多借贷协议
- 和下一跳行为串起来看

### 8.5 `vault-share-discount-redeem`

第一版：

- 维护一个可配置的 `shareToken -> underlyingToken` 映射
- 观察一笔交易里两类 token 是否都被触发
- 若再叠加 swap / withdraw / unwrap，就作为候选输出

后续增强：

- 增加 vault-specific 事件识别
- 结合价格和 pool 份额做更强的折价判断

### 8.6 `liquidation-deleverage-imbalance`

第一版：

- 直接识别 `LiquidationCall`
- 或识别以下组合：
  - `flash loan + repay + withdraw`
  - `repay + withdraw + multi-pool-swap`

后续增强：

- 做同块上下文关联
- 看 liquidation 前后局部状态是否暴露二次机会

## 9. 分数体系

建议分数是启发式权重，不要过度复杂。

例如：

- `flash-loan`：3 分
- `multi-pool-swap`：2 分
- `wrap-unwrap-redeem`：2 分
- `reserve-liquidity-shift`：3 分
- `vault-share-discount-redeem`：3 分
- `liquidation-deleverage-imbalance`：3 分

组合加分：

- 标签数 >= 3 时额外加 1 分

这样做的目的不是精确排序，而是：

- 快速把最像“非普通用户行为”的交易顶出来

## 10. 默认关注的市场

为了让第一版更贴近你当前项目，建议默认关注：

- Aave V3 Arbitrum
- WETH reserve
- `aArbWETH -> WETH`

原因：

- 这块你已经有实战经验
- 规则容易验证
- 很适合把“状态套利”和“折价赎回”这两类机会串起来

但架构上不要把自己锁死在这一个市场里。

所有监控对象都应该尽量做成配置化：

- reserve 地址可配置
- share pair 可配置
- tag 阈值可配置

## 11. 结果长什么样

每条候选建议输出成类似结构：

```json
{
  "txHash": "0x...",
  "blockNumber": 123,
  "tags": [
    "flash-loan",
    "multi-pool-swap",
    "liquidation-deleverage-imbalance"
  ],
  "score": 8,
  "summary": "tags=flash-loan,multi-pool-swap,... swapPools=3 reserveUpWei=...",
  "protocols": [
    "aave-v3",
    "uniswap-v3-like"
  ],
  "evidence": [
    "flash loan asset=... amount=...",
    "aave repay reserve=... amount=..."
  ]
}
```

关键点：

- 可读
- 可 grep
- 可后续批处理

## 12. 第一阶段交付标准

我认为第一阶段做完，至少应该满足：

1. 能稳定 live 扫新区块
2. 能稳定 backfill 历史区块
3. 能分析单笔交易
4. 能输出六类基础标签
5. 能通过配置扩 reserve 和 share pair
6. 输出结果可以直接拿去选样本

## 13. 第二阶段再做什么

等第一阶段稳定后，再考虑：

### 13.1 协议特化规则

像你现在的项目一样，把“通用标签”扩成“协议特化识别”：

- 某类 router
- 某类 vault
- 某类 deleverage recipe

### 13.2 replay 验证

把候选交易自动送进 replay 流程：

- 还原区块前状态
- 模拟候选路径
- 看机会是否能被复现

### 13.3 同块上下文分析

研究：

- 目标交易之前发生了什么
- 目标交易之后又留下了什么状态

### 13.4 执行链路

最后才轮到：

- pending / feed / sequencer
- gas 和广播
- 自动执行

## 14. 当前方案的局限

这版方案有几个明确局限：

1. 标签是启发式的，不是形式化证明
2. 还没做 token decimals 和真实 PnL
3. 还没做复杂 router 深度解码
4. 还没做多协议完整覆盖
5. 还没做跨交易、跨区块的上下文建模

但这些局限是可以接受的，因为当前目标就是：

先把研究入口做出来。

## 15. 推荐推进顺序

如果你认可这个方向，我建议实施顺序是：

1. 先搭最小扫描器
2. 跑 live + backfill 看样本量
3. 调整标签阈值
4. 增加 `aArbWETH/WETH` 的特化规则
5. 选 10 到 20 笔候选做人工复盘
6. 再决定第二阶段重点放 replay 还是更深的协议识别

## 16. 最后的判断

这套项目不该一开始就长成“执行器”，它更应该先长成：

- 一个结构化候选发现器
- 一个链上异常状态的筛选器
- 一个给后续套利研究持续供样本的工具

如果方向对了，后面 executor 只是后续模块；
如果方向没对，执行做得再快也只是在更快地追错目标。
