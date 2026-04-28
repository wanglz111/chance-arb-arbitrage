# chance-arb-arbitrage

Arbitrum 上的“候选发现”扫描器。它不发单、不抢执行，只做三件事：

- 扫描新区块或历史区块
- 对可疑交易打标签
- 把候选结果输出到终端和 `jsonl`

当前支持的候选标签：

- `flash-loan`
- `payout`
- `multi-pool-swap`
- `wrap-unwrap-redeem`
- `reserve-liquidity-shift`
- `vault-share-discount-redeem`
- `liquidation-deleverage-imbalance`

当前已直接识别的 flash loan 入口：

- Aave V3 `FlashLoan` 事件
- Balancer V2 Vault `FlashLoan` 事件
- Morpho `FlashLoan` 事件
- Uniswap V3 pool `Flash` 事件

## 安装

```bash
npm install
cp .env.example .env
```

最少需要配置：

```env
RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## 启动实时扫描

```bash
npm run start
```

默认是 `block-poll` 模式，也就是按块轮询整块交易和回执。

如果你想改成 “Alchemy WS 精准订阅 flash loan logs，再按命中的 tx 做分类”，先配置：

```env
LIVE_MODE=ws-flashloan
WS_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
```

然后运行：

```bash
npm run start:ws
```

默认会把 live 进度写到 `CHECKPOINT_PATH`，重连后先做一次缺口补扫，再继续订阅。

## 分析单笔交易

```bash
npm run analyze:tx -- 0xYOUR_TX_HASH
```

## 浏览候选结果

```bash
npm run view:candidates
```

默认会读取 `./data/candidates.jsonl`，并在本地打开一个 viewer：

- 总览统计：总样本、flash loan 数、payout 数、平均分
- 筛选：`tag / protocol / route hint / flash loan only / payout only / search`
- 详情：`flashLoans / payouts / evidence / raw json`

如果你想看别的文件：

```bash
npm run view:candidates -- ./data/candidates.jsonl
```

## 回扫历史区块

```bash
npm run backfill -- --from 320000000 --to 320000050
```

默认 `backfill` 走 `logs-first` 模式，也就是先按 flash signal 的 `address/topic` 命中交易，再只分析这些 tx，CU 明显低于整块扫描。

如果你想强制整块扫：

```bash
npm run backfill -- --from 320000000 --to 320000050 --mode blocks
```

如果回扫中断了，可以用相同参数加 `--resume` 从 checkpoint 继续：

```bash
npm run backfill -- --from 320000000 --to 320000050 --mode logs --resume
```

## 设计思路

这套工具故意停在“研究型扫描器”阶段，不追求自动执行。

- 输入：整块交易和回执
- 处理：基于 log + 监控 token pair 做启发式分类
- 输出：候选标签、分数、证据、协议触点，以及更结构化的 flash loan / payout / route hint 数据
- 状态：本地 checkpoint + `txHash` 去重，降低重复写入和断线遗漏

当前支持两种 live 模式：

- `block-poll`：整块扫描，适合稳定回收所有候选
- `ws-flashloan`：订阅 Aave V3 / Balancer V2 / Morpho / Uniswap V3 的 flash 信号，再按命中的 tx 做分类

默认配置偏向 Arbitrum + Aave `aArbWETH/WETH` 的机会发现，但你可以通过 `.env` 继续扩充 `MONITORED_RESERVES` 和 `MONITORED_SHARE_PAIRS`。

## 结果说明

这是启发式候选发现，不是利润证明器。

- 它擅长把“值得继续 replay/回放”的交易筛出来
- 它不保证这笔交易一定能套利
- 它也不保证当前标签已经覆盖所有协议路径

当前结果里除了 `tags / score / evidence`，还会额外输出：

- `flashLoans`：协议、provider、asset、amount、premium、callback、receiver/caller
- `payouts`：对 `tx.from`、flash loan caller/receiver 等关键地址做 ERC20 净流入提取，并补充“关键地址向外部终局地址分发”的 payout 线索
- `routeHints`：如 `flash-loan -> payout`、`morpho-free-flash-loan` 这类便于后续前端聚类的路径提示

## 运行建议

- 如果你的 RPC 对 `eth_getLogs` block range 限得很紧，把 `LOG_BACKFILL_BLOCK_SPAN` 设小一点，例如 `10`
- `OUTPUT_PATH` 继续用 `jsonl` 没问题，研究期足够顺手
- `CHECKPOINT_PATH` 建议单独放在 `./data/checkpoints.json`

后续如果你要继续扩，我建议先补：

1. 协议特化 router 规则
2. 单笔交易 replay 验证
3. 候选结果分组和去重
