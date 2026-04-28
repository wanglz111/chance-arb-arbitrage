import { Interface, id } from "ethers";

export const ARBITRUM_CHAIN_NAME = "arbitrum";
export const AAVE_V3_POOL_ADDRESS = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
export const BALANCER_V2_VAULT_ADDRESS = "0xba12222222228d8ba445958a75a0704d566bf2c8";
export const WETH_ADDRESS = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
export const AARBWETH_ADDRESS = "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8";

export const aavePoolInterface = new Interface([
  "event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)",
  "event Repay(address indexed reserve,address indexed user,address indexed repayer,uint256 amount,bool useATokens)",
  "event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)",
  "event Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)",
  "event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)",
  "event FlashLoan(address indexed target,address initiator,address indexed asset,uint256 amount,uint8 interestRateMode,uint256 premium,uint16 indexed referralCode)"
]);

export const morphoInterface = new Interface([
  "event FlashLoan(address indexed caller,address indexed token,uint256 assets)"
]);

export const balancerVaultInterface = new Interface([
  "event FlashLoan(address indexed recipient,address indexed token,uint256 amount,uint256 feeAmount)"
]);

export const uniswapV2LikeInterface = new Interface([
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"
]);

export const uniswapV3LikeInterface = new Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Flash(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1,uint256 paid0,uint256 paid1)",
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"
]);

export const wethInterface = new Interface([
  "event Deposit(address indexed dst,uint256 wad)",
  "event Withdrawal(address indexed src,uint256 wad)"
]);

export const erc20Interface = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);

export const erc4626LikeInterface = new Interface([
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)"
]);

export const TOPICS = {
  aaveBorrow: id("Borrow(address,address,address,uint256,uint8,uint256,uint16)").toLowerCase(),
  aaveFlashLoan: id("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)").toLowerCase(),
  aaveLiquidationCall: id("LiquidationCall(address,address,address,uint256,uint256,address,bool)").toLowerCase(),
  aaveRepay: id("Repay(address,address,address,uint256,bool)").toLowerCase(),
  aaveSupply: id("Supply(address,address,address,uint256,uint16)").toLowerCase(),
  aaveWithdraw: id("Withdraw(address,address,address,uint256)").toLowerCase(),
  balancerFlashLoan: id("FlashLoan(address,address,uint256,uint256)").toLowerCase(),
  erc20Transfer: id("Transfer(address,address,uint256)").toLowerCase(),
  erc4626Deposit: id("Deposit(address,address,uint256,uint256)").toLowerCase(),
  erc4626Withdraw: id("Withdraw(address,address,address,uint256,uint256)").toLowerCase(),
  morphoFlashLoan: id("FlashLoan(address,address,uint256)").toLowerCase(),
  uniswapV3Flash: id("Flash(address,address,uint256,uint256,uint256,uint256)").toLowerCase(),
  uniswapV2Swap: id("Swap(address,uint256,uint256,uint256,uint256,address)").toLowerCase(),
  uniswapV3Swap: id("Swap(address,address,int256,int256,uint160,uint128,int24)").toLowerCase(),
  wethDeposit: id("Deposit(address,uint256)").toLowerCase(),
  wethWithdrawal: id("Withdrawal(address,uint256)").toLowerCase()
} as const;
