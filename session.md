# Session

## Purpose

这个文件用于保存当前项目的工作上下文，供后续 AI 或人工快速接手。

使用规则：

1. 开始新工作前，先读 `session.md` 和 `architect.md`
2. 以 `session.md` 的 `Current Status` 为最新进度基线
3. 每次有实质进展后，更新 `Current Status`，并在 `Update Log` 追加一条记录
4. 不要删除旧记录，尽量追加而不是重写历史

## Project

- Project path: `/Users/edy/lucas/chance-arb-arbitrage`
- Primary document: [architect.md](/Users/edy/lucas/chance-arb-arbitrage/architect.md:1)
- Current phase: flash-loan discovery implementation

## Goal

第一阶段目标不是自动执行套利，而是搭建一套“候选发现”扫描器：

- 扫描链上交易
- 给可疑交易打标签
- 为后续 replay、验证、协议特化研究提供样本

候选标签目标包括：

- `flash-loan`
- `multi-pool-swap`
- `wrap-unwrap-redeem`
- `reserve-liquidity-shift`
- `vault-share-discount-redeem`
- `liquidation-deleverage-imbalance`

## Key Decisions

- 先做 discovery，不做执行器
- 先做启发式标签和候选筛选，不做严格利润证明
- 第一阶段优先使用 `HTTP RPC + block polling`
- 输出以结构化结果为主，便于后续 grep、统计、回放和人工复盘
- 默认先围绕 Arbitrum + Aave + `aArbWETH/WETH` 方向设计，但架构应保持可配置

## Current Status

截至 `2026-04-28`，当前状态如下：

- discovery scanner 骨架已继续推进，不再只是“待确认草稿”
- 已补齐 Aave V3 `FlashLoan` 的直接事件识别，并修正相关 Aave event ABI 的 `indexed` 定义
- 已新增 Morpho `FlashLoan` 事件识别，默认把 Morpho 视为 fee-free flash loan，并输出 `onMorphoFlashLoan` callback 线索
- 已新增 payout 抽取：基于 ERC20 `Transfer` 对 `tx.from`、flash loan caller/receiver 等关键地址做净流入统计
- 候选输出已扩展为更适合研究和后续前端消费的结构：`flashLoans`、`payouts`、`routeHints`
- 已通过 `npm run check`，并跑过本地合成样例，确认 Aave / Morpho 两条典型路径能产出预期结构
- 已新增第二种 live 模式 `ws-flashloan`：通过 WS 订阅 Aave V3 / Morpho flash loan log，命中后按单笔 tx 拉取并分类
- 已新增本地候选 viewer：直接浏览 `candidates.jsonl`，按 `tag / protocol / route hint / flash loan / payout` 做筛选

当前目录文件状态：

- 文档：
  - `architect.md`
  - `README.md`
  - `session.md`
- 已进入有效实现的代码：
  - `src/*.ts`
  - `scripts/*.ts`
  - `package.json`
  - `tsconfig.json`
  - `.env.example`

当前仍待继续推进的事项：

- 补更多协议的 flash loan 事件和 callback 规则
- 把 payout 从“ERC20 净流入启发式”扩到更完整的余额/trace 视角
- 归纳更稳定的经典路径分组，并设计一个简单前端去看样本
- 为 WS 模式补更完整的断线补扫 / 持久化 checkpoint，减少重连期间漏样本
- 如果 `jsonl` 继续变大，可把 viewer 从“全文件内存过滤”升级为增量索引或 SQLite

## Important Context

这几点对后续接手很重要：

- 当前项目已经从文档阶段进入可运行的 discovery scanner 实现阶段
- 当前实现重点已经从“泛化候选打标”前移到“flash loan 开局 + payout 归宿 + 经典路径学习”
- payout 目前仍是 receipt/log 级启发式，不是严格余额证明；如果后续要更像利润验证器，应该补 trace 或 replay

## Recommended Next Step

推荐下一步顺序：

1. 补更多协议的 flash loan 事件和 callback 规则
2. 归纳经典路径，并按 `routeHints` 做样本分组
3. 设计一个简单前端，先把 `flashLoans / payouts / routeHints / evidence` 看顺
4. 再决定是否进入 replay / trace / 更严格的余额验证

## Files To Read First

后续 AI 接手时，建议先读：

1. [session.md](/Users/edy/lucas/chance-arb-arbitrage/session.md:1)
2. [architect.md](/Users/edy/lucas/chance-arb-arbitrage/architect.md:1)
3. [README.md](/Users/edy/lucas/chance-arb-arbitrage/README.md:1)

如果决定继续实现，再读：

4. [src/classifier.ts](/Users/edy/lucas/chance-arb-arbitrage/src/classifier.ts:1)
5. [src/service.ts](/Users/edy/lucas/chance-arb-arbitrage/src/service.ts:1)
6. [src/fetcher.ts](/Users/edy/lucas/chance-arb-arbitrage/src/fetcher.ts:1)

## Update Log

### 2026-04-28

- 创建项目目录 `chance-arb-arbitrage`
- 先行写入了一套 discovery scanner 的初始代码骨架
- 根据用户要求，暂停实现，转而补充架构说明文档 `architect.md`
- 新增 `session.md`，作为后续持续维护的上下文文件
- 继续推进实现：新增 Aave V3 / Morpho flash loan 识别、payout 提取、route hint 输出，并通过 `npm run check`
- 新增 `ws-flashloan` live 模式、`WS_RPC_URL` 等配置项，以及 `npm run start:ws` 入口
- 新增 `npm run view:candidates` 本地浏览器，用于查看 `data/candidates.jsonl`
