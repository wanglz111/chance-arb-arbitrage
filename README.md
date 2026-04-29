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

## Docker

本项目现在可以直接以 Docker / Docker Compose 方式部署。

先准备 `.env`：

```bash
cp .env.example .env
```

如果你准备长期监听新事件，通常至少改这几项：

```env
LIVE_MODE=ws-flashloan
WS_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
WS_CHECKPOINT_INTERVAL_MS=60000
OUTPUT_PATH=/app/data/candidates.jsonl
CHECKPOINT_PATH=/app/data/checkpoints.json
```

默认 compose 会直接拉：

```text
ghcr.io/wanglz111/chance-arb-arbitrage:latest
```

启动：

```bash
docker login ghcr.io
docker compose pull
docker compose up -d scanner viewer
```

如果你想切到指定 tag 或 sha，改一个环境变量就行：

```bash
export CHANCE_ARB_IMAGE=ghcr.io/wanglz111/chance-arb-arbitrage:latest
docker compose pull
docker compose up -d scanner viewer
```

例如固定到某个版本：

```bash
export CHANCE_ARB_IMAGE=ghcr.io/wanglz111/chance-arb-arbitrage:v0.1.0
docker compose pull
docker compose up -d scanner viewer
```

例如固定到某个 commit sha tag：

```bash
export CHANCE_ARB_IMAGE=ghcr.io/wanglz111/chance-arb-arbitrage:sha-63cb577
docker compose pull
docker compose up -d scanner viewer
```

说明：

- `scanner`：长期运行的候选发现进程
- `viewer`：读取 `./data/candidates-YYYY-MM-DD.jsonl`，开放 `4310` 端口，并支持按 UTC 日期切换
- `uploader`：每天 UTC 00:00 把前一天的 `./data/candidates-YYYY-MM-DD.jsonl` 上传到 Cloudflare R2
- 宿主机 `./data` 会映射到容器里的 `/app/data`

如果你只想跑扫描器：

```bash
docker compose up -d scanner
```

如果你要自动上传到 Cloudflare R2，先在 `.env` 里补：

```env
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET=your_bucket
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_KEY_PREFIX=chance-arb/candidates
R2_LATEST_KEY=chance-arb/candidates/latest.jsonl
R2_UPLOAD_RETRY_SECONDS=300
```

然后启动上传器：

```bash
docker compose up -d uploader
```

上传器会等到每天 UTC 00:00，把前一天的文件上传到 `R2_KEY_PREFIX` 下面，例如 `chance-arb/candidates/candidates-2026-04-29.jsonl`；如果配置了 `R2_LATEST_KEY`，还会额外覆盖一份固定路径的最新快照。

如果你要手动补传某一天：

```bash
docker compose run --rm uploader node dist/scripts/upload-candidates-r2.js --date 2026-04-29
```

如果你要做一次性历史回扫：

```bash
docker compose run --rm scanner node dist/scripts/backfill-block-range.js --from 320000000 --to 320000050 --mode logs
```

## 服务器运维

如果你准备把它长期放在服务器 Docker 里跑，最常用的方法就是下面这几种。

查看服务状态：

```bash
docker compose ps
```

查看扫描器日志：

```bash
docker compose logs -f scanner
```

查看 viewer 日志：

```bash
docker compose logs -f viewer
```

重启扫描器：

```bash
docker compose restart scanner
```

停止所有服务：

```bash
docker compose down
```

如果你使用 GitHub Actions 推到 GHCR 的镜像更新：

```bash
export CHANCE_ARB_IMAGE=ghcr.io/wanglz111/chance-arb-arbitrage:latest
docker compose pull
docker compose up -d
```

如果你只想更新扫描器：

```bash
docker compose pull scanner
docker compose up -d scanner
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
# optional; default is 60000
WS_CHECKPOINT_INTERVAL_MS=60000
```

然后运行：

```bash
npm run start:ws
```

默认会把 live 进度写到 `CHECKPOINT_PATH`，重连后先做一次缺口补扫，再继续订阅。`ws-flashloan` 只订阅 flash loan `logs`，不会订阅 `newHeads`；`wsSyncedBlock` 由低频 `eth_blockNumber` 轮询推进，间隔可用 `WS_CHECKPOINT_INTERVAL_MS` 调整。

## 分析单笔交易

```bash
npm run analyze:tx -- 0xYOUR_TX_HASH
```

## 浏览候选结果

```bash
npm run view:candidates
```

默认会读取 `./data/candidates-YYYY-MM-DD.jsonl`，并在本地打开一个 viewer：

- 总览统计：总样本、flash loan 数、payout 数、平均分
- 筛选：`UTC day / tag / protocol / route hint / flash loan only / payout only / search`
- 详情：`flashLoans / payouts / evidence / raw json`

如果你想换路径模板：

```bash
npm run view:candidates -- ./data/candidates.jsonl
```

viewer 会把这个路径当成模板，自动扫描同目录下的 `candidates-YYYY-MM-DD.jsonl`，页面里可以按 UTC 日期选择。

## 分析 24 小时候选路径

扫描跑满一天后，可以直接把 `jsonl` 喂给离线分析脚本：

```bash
npm run analyze:candidates -- ./data/candidates-2026-04-29.jsonl --since-hours 24 --min-score 6 --top 20
```

它会在终端输出摘要，并默认写出结构化报告：

```text
./data/candidate-analysis-report.json
```

这个报告是后续给 Codex 复盘用的，里面按路径保留了频次、平均分、代表交易、payout、证据和协议组合。它会包含：

- 常见 flash loan 路径
- 常见 route hint
- 协议组合
- 标签组合
- 高频目标合约
- 高分样本交易

如果你想指定报告文件名：

```bash
npm run analyze:candidates -- ./data/candidates-24h.jsonl --since-hours 24 --min-score 6 --report ./data/report-24h.json
```

如果你是把服务器上的 24 小时结果拷到本地，例如 `./data/candidates-24h.jsonl`：

```bash
npm run analyze:candidates -- ./data/candidates-24h.jsonl --since-hours 24 --min-score 6
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

## 数据格式

运行时主要会写两类文件：

- `OUTPUT_PATH`
  默认 `./data/candidates.jsonl`，实际会按 UTC 日期写成 `./data/candidates-YYYY-MM-DD.jsonl`
- `CHECKPOINT_PATH`
  默认 `./data/checkpoints.json`
- `R2_*`
  Cloudflare R2 上传配置。`R2_KEY_PREFIX` 控制上传到 bucket 里的哪个路径前缀，`R2_LATEST_KEY` 控制是否额外维护一份固定路径的最新快照；上传器按 UTC 日切分，每天 UTC 00:00 上传前一天。

为了方便人工和 AI 阅读，仓库里附带了两份静态样例：

- [examples/candidates.sample.jsonl](/Users/edy/lucas/chance-arb-arbitrage/examples/candidates.sample.jsonl:1)
- [examples/checkpoints.sample.json](/Users/edy/lucas/chance-arb-arbitrage/examples/checkpoints.sample.json:1)

### `candidates-YYYY-MM-DD.jsonl`

- 文件格式：`JSONL`
- 一行一条 `Candidate`
- 每行都是完整 JSON 对象，适合 `tail -F`、grep、流式消费

字段结构：

```json
{
  "blockNumber": 457041846,
  "chainName": "arbitrum",
  "evidence": ["..."],
  "flashLoans": [
    {
      "amountWei": "332645654622239468",
      "asset": "0x82af...",
      "callback": "onMorphoFlashLoan",
      "caller": "0x860a...",
      "initiator": null,
      "premiumWei": "0",
      "protocol": "morpho",
      "provider": "0x6c24...",
      "receiver": "0x860a..."
    }
  ],
  "from": "0x6666...",
  "gasUsedWei": "653598",
  "metrics": {
    "flashLoanAmountWei": "332645654622239468",
    "flashLoanCount": 1,
    "payoutAddressCount": 1,
    "payoutTokenCount": 1,
    "reserveShiftDownWei": "333698470268187288",
    "reserveShiftUpWei": "0",
    "swapEvents": 1,
    "swapPools": 1,
    "wethDepositWei": "0",
    "wethWithdrawalWei": "0"
  },
  "payouts": [
    {
      "kind": "external-transfer",
      "netAmountWei": "1086076885286110",
      "recipient": "0x4f46...",
      "token": "0x82af..."
    }
  ],
  "protocols": ["aave-v3", "morpho", "uniswap-v3-like"],
  "routeHints": ["flash-loan -> payout", "flash-loan-open"],
  "score": 8,
  "summary": "tags=flash-loan,payout,...",
  "tags": ["flash-loan", "payout", "vault-share-discount-redeem"],
  "timestamp": 1777332244,
  "to": "0x860a...",
  "txHash": "0xde00...",
  "txIndex": 2
}
```

字段说明：

- `blockNumber` / `txHash` / `txIndex`
  候选交易定位信息
- `from` / `to`
  原始交易发起方和目标地址
- `tags`
  当前分类器给出的候选标签
- `score`
  启发式分数，用于粗排序
- `summary`
  为 grep / 终端日志压缩过的一行摘要
- `protocols`
  本笔交易触达过的协议集合
- `routeHints`
  更偏路径视角的提示，如 `flash-loan -> payout`
- `flashLoans`
  识别到的 flash loan / flash leg 列表
- `payouts`
  候选 payout 线索
  `kind=net-inflow` 表示关键地址净流入
  `kind=external-transfer` 表示关键地址向外部终局地址分发
- `metrics`
  一些适合统计和筛选的数值字段
- `evidence`
  原始启发式证据文本，便于人工复盘

### `checkpoints.json`

- 文件格式：普通 JSON
- 用来记录 live / backfill 的运行进度

字段结构：

```json
{
  "backfills": {
    "logs:320000000:320000050": {
      "fromBlock": 320000000,
      "mode": "logs",
      "nextBlock": 320000021,
      "toBlock": 320000050,
      "updatedAt": "2026-04-28T07:00:00.000Z"
    }
  },
  "live": {
    "blockPollNextBlock": 457153000,
    "wsSyncedBlock": 457153228
  }
}
```

字段说明：

- `backfills`
  每个历史回扫任务的游标，key 形如 `logs:from:to`
- `live.blockPollNextBlock`
  `block-poll` 模式下次要扫的块高
- `live.wsSyncedBlock`
  `ws-flashloan` 最近确认已经补齐到的块高

## 运行建议

- 如果你的 RPC 对 `eth_getLogs` block range 限得很紧，把 `LOG_BACKFILL_BLOCK_SPAN` 设小一点，例如 `10`
- `OUTPUT_PATH` 继续用 `jsonl` 没问题，研究期足够顺手
- `CHECKPOINT_PATH` 建议单独放在 `./data/checkpoints.json`

## 监控与取数

如果你放在服务器的 Docker 里跑，最直接的监控方式有三种：

- 看扫描器日志：

```bash
docker compose logs -f scanner
```

- 打开 viewer：

```text
http://<server-ip>:4310
```

- 直接看宿主机上的结果文件：

```bash
tail -f ./data/candidates-$(date -u +%F).jsonl
cat ./data/checkpoints.json
```

因为 `./data` 是挂载卷，所以你不需要特地从容器里导出数据：

- 候选结果：`./data/candidates-YYYY-MM-DD.jsonl`
- 运行进度：`./data/checkpoints.json`

如果你后面要把数据送到别的地方，最简单的做法是：

- 用 `tail -F ./data/candidates-$(date -u +%F).jsonl` 做流式消费
- 定时把 `./data/candidates-YYYY-MM-DD.jsonl` 同步到对象存储
- 或者下一步直接把 writer 升级成 SQLite / Postgres

如果你只是想把结果拿出来做离线分析，最简单的是：

```bash
cp ./data/candidates-$(date -u +%F).jsonl ./candidates-$(date -u +%F-%H%M%S).jsonl
```

如果你想从容器内部直接读文件，也可以：

```bash
docker compose exec scanner sh -lc 'ls -lah /app/data && tail -n 20 /app/data/candidates-$(date -u +%F).jsonl'
```

后续如果你要继续扩，我建议先补：

1. 协议特化 router 规则
2. 单笔交易 replay 验证
3. 候选结果分组和去重
