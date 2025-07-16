import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { Keypair as SolanaKeypair, Connection as SolanaConnection, LAMPORTS_PER_SOL, PublicKey as SolanaPublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import Web3 from 'web3';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import http from 'http';
import fetch from 'node-fetch';
import raydiumSdk from '@raydium-io/raydium-sdk';
const { Liquidity, LiquidityPoolKeys, LiquidityPoolJsonInfo, LiquidityPoolInfoLayout, MAINNET_PROGRAM_ID, TokenAmount, Token: RayToken, buildSimpleTransaction, jsonInfo2PoolKeys } = raydiumSdk;
dotenv.config();
const BOT_TOKEN = process.env.TOKEN_ADDRESS;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const bot = new Telegraf(BOT_TOKEN);

// In-memory user session (for demo; use DB in production)
const userSessions = {};

function getUserSession(ctx) {
  if (!userSessions[ctx.from.id]) {
    userSessions[ctx.from.id] = { wallets: {} };
  }
  if (!userSessions[ctx.from.id].wallets) {
    userSessions[ctx.from.id].wallets = {};
  }
  return userSessions[ctx.from.id];
}

const NETWORKS = ['Solana', 'BSC', 'Ethereum'];
const SPEEDS = [
  { label: '🐢 Slow (4 trx/20s)', value: 'slow', rate: 4 },
  { label: '🚗 Moderate (9 trx/20s)', value: 'moderate', rate: 9 },
  { label: '🚀 Fast (12 trx/20s)', value: 'fast', rate: 12 },
];

// PancakeSwap and Uniswap Router ABIs (simplified for swapExactETHForTokens)
const PANCAKE_ROUTER_ABI = [
  {
    "inputs": [
      { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
      { "internalType": "address[]", "name": "path", "type": "address[]" },
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "deadline", "type": "uint256" }
    ],
    "name": "swapExactETHForTokens",
    "outputs": [ { "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" } ],
    "stateMutability": "payable",
    "type": "function"
  }
];
const UNISWAP_ROUTER_ABI = PANCAKE_ROUTER_ABI;

const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const UNISWAP_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// RPC URLs (use your own for production)
const SOLANA_RPC = process.env.SOL_RPC_URL;
const BSC_RPC = process.env.BSC_RPC_URL;
const ETH_RPC = `https://distinguished-twilight-lake.quiknode.pro/${process.env.QUICKNODE_KEY}/`;

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('VolumeBot is running!');
});

server.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. HTTP server not started, but bot will continue running.`);
  } else {
    console.error('Server error:', err);
  }
});

function getNetworkFromAddress(address, session) {
  // Solana: base58, 32-44 chars, no 0x
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'Solana';
  // If user has selected BSC, treat as BSC
  if (session && session.tradeNetwork === 'BSC' && /^0x[a-fA-F0-9]{40}$/.test(address)) return 'BSC';
  // Otherwise, treat as Ethereum
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'Ethereum';
  return null;
}

function formatWalletList(wallets, network) {
  return wallets.map((w, i) => `Wallet #${i+1}\nPublic: <code>${w.public}</code>\nPrivate: <code>${w.private}</code>`).join('\n\n');
}

async function getWalletBalance(network, pubkey) {
  try {
    if (network === 'Solana') {
      const conn = new SolanaConnection(SOLANA_RPC);
      const balance = await conn.getBalance(new SolanaPublicKey(pubkey));
      return balance / LAMPORTS_PER_SOL;
    } else if (network === 'Ethereum') {
      const web3 = new Web3(ETH_RPC);
      const balance = await web3.eth.getBalance(pubkey);
      return web3.utils.fromWei(balance, 'ether');
    } else if (network === 'BSC') {
      const web3 = new Web3(BSC_RPC);
      const balance = await web3.eth.getBalance(pubkey);
      return web3.utils.fromWei(balance, 'ether');
    }
  } catch (e) {
    return 'Error';
  }
}

async function sendBuyTx(network, priv, tokenAddress, amount, slippage = 1) {
  try {
    if (network === 'Ethereum') {
      const web3 = new Web3(ETH_RPC);
      const account = web3.eth.accounts.privateKeyToAccount(priv);
      web3.eth.accounts.wallet.add(account);
      const router = new web3.eth.Contract(UNISWAP_ROUTER_ABI, UNISWAP_ROUTER);
      const path = [WETH, tokenAddress];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
      // Get expected amountOutMin using router.getAmountsOut
      let amountInWei = web3.utils.toWei(amount.toString(), 'ether');
      let amountsOut;
      try {
        amountsOut = await router.methods.getAmountsOut(amountInWei, path).call();
      } catch (e) {
        return { success: false, error: 'Failed to fetch price for slippage calculation.' };
      }
      let amountOutMin = amountsOut[1] - (amountsOut[1] * slippage / 100);
      amountOutMin = Math.floor(amountOutMin);
      const tx = router.methods.swapExactETHForTokens(
        amountOutMin, path, account.address, deadline
      );
      const gas = await tx.estimateGas({ from: account.address, value: amountInWei });
      const data = tx.encodeABI();
      const txData = {
        from: account.address,
        to: UNISWAP_ROUTER,
        data,
        value: amountInWei,
        gas
      };
      const receipt = await web3.eth.sendTransaction(txData);
      return { success: true, txid: receipt.transactionHash };
    } else if (network === 'BSC') {
      const web3 = new Web3(BSC_RPC);
      const account = web3.eth.accounts.privateKeyToAccount(priv);
      web3.eth.accounts.wallet.add(account);
      const router = new web3.eth.Contract(PANCAKE_ROUTER_ABI, PANCAKE_ROUTER);
      const path = [WBNB, tokenAddress];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
      let amountInWei = web3.utils.toWei(amount.toString(), 'ether');
      let amountsOut;
      try {
        amountsOut = await router.methods.getAmountsOut(amountInWei, path).call();
      } catch (e) {
        return { success: false, error: 'Failed to fetch price for slippage calculation.' };
      }
      let amountOutMin = amountsOut[1] - (amountsOut[1] * slippage / 100);
      amountOutMin = Math.floor(amountOutMin);
      const tx = router.methods.swapExactETHForTokens(
        amountOutMin, path, account.address, deadline
      );
      const gas = await tx.estimateGas({ from: account.address, value: amountInWei });
      const data = tx.encodeABI();
      const txData = {
        from: account.address,
        to: PANCAKE_ROUTER,
        data,
        value: amountInWei,
        gas
      };
      const receipt = await web3.eth.sendTransaction(txData);
      return { success: true, txid: receipt.transactionHash };
    } else if (network === 'Solana') {
      // --- Raydium swap: SOL -> token ---
      const conn = new SolanaConnection(SOLANA_RPC, 'confirmed');
      const from = SolanaKeypair.fromSecretKey(Buffer.from(priv, 'hex'));
      // Find Raydium pool for SOL/token
      const poolsResp = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
      const pools = await poolsResp.json();
      const poolInfo = Object.values(pools.pools).find(
        (p) => (p.baseMint === tokenAddress || p.quoteMint === tokenAddress) && (p.baseMint === 'So11111111111111111111111111111111111111112' || p.quoteMint === 'So11111111111111111111111111111111111111112')
      );
      if (!poolInfo) return { success: false, error: 'No Raydium pool found for this token.' };
      const poolKeys = jsonInfo2PoolKeys(poolInfo);
      // Prepare swap
      const inToken = poolKeys.baseMint === 'So11111111111111111111111111111111111111112' ? poolKeys.base : poolKeys.quote;
      const outToken = poolKeys.baseMint === tokenAddress ? poolKeys.base : poolKeys.quote;
      const inAmount = new TokenAmount(new RayToken(inToken.mint, inToken.decimals), Math.floor(amount * 10 ** inToken.decimals));
      // Estimate minOutAmount with slippage
      let minOutAmount = 1;
      try {
        // Raydium does not have a direct getAmountsOut, so use 1 - slippage% for minOutAmount
        minOutAmount = Math.floor(inAmount.raw * (1 - slippage / 100));
      } catch (e) {
        minOutAmount = 1;
      }
      const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
        poolKeys,
        userKeys: {
          tokenAccounts: await getAssociatedTokenAddress(
            new SolanaPublicKey(outToken.mint),
            from.publicKey
          ),
          owner: from.publicKey,
          payer: from.publicKey,
        },
        amountIn: inAmount.raw,
        amountOut: minOutAmount,
        fixedSide: 'in',
        connection: conn,
        makeTxVersion: 0,
      });
      const tx = new Transaction();
      for (const ix of innerTransactions[0].instructions) tx.add(ix);
      tx.feePayer = from.publicKey;
      tx.recentBlockhash = (await conn.getRecentBlockhash()).blockhash;
      const sig = await conn.sendTransaction(tx, [from]);
      await conn.confirmTransaction(sig);
      return { success: true, txid: sig };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- ERC20 ABI for approve and balanceOf ---
const ERC20_ABI = [
  // balanceOf
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  // approve
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: 'success', type: 'bool' }],
    type: 'function',
  },
  // allowance
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: 'remaining', type: 'uint256' }],
    type: 'function',
  },
];

// --- Sell Transaction Function ---
async function sendSellTx(network, priv, tokenAddress, amount, slippage = 1) {
  try {
    if (network === 'Ethereum') {
      const web3 = new Web3(ETH_RPC);
      const account = web3.eth.accounts.privateKeyToAccount(priv);
      web3.eth.accounts.wallet.add(account);
      // Approve Uniswap router to spend the token
      const token = new web3.eth.Contract(ERC20_ABI, tokenAddress);
      const decimals = await token.methods.decimals().call();
      const tokenBalance = await token.methods.balanceOf(account.address).call();
      const approveAmount = tokenBalance; // Approve all tokens
      await token.methods.approve(UNISWAP_ROUTER, approveAmount).send({ from: account.address });
      // Swap tokens for ETH
      const router = new web3.eth.Contract(UNISWAP_ROUTER_ABI, UNISWAP_ROUTER);
      const path = [tokenAddress, WETH];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
      // Get expected amountOutMin using router.getAmountsOut
      let amountsOut;
      try {
        amountsOut = await router.methods.getAmountsOut(approveAmount, path).call();
      } catch (e) {
        return { success: false, error: 'Failed to fetch price for slippage calculation.' };
      }
      let amountOutMin = amountsOut[1] - (amountsOut[1] * slippage / 100);
      amountOutMin = Math.floor(amountOutMin);
      const tx = router.methods.swapExactTokensForETH(
        approveAmount, // amountIn
        amountOutMin, // amountOutMin
        path,
        account.address, // to: self
        deadline
      );
      const gas = await tx.estimateGas({ from: account.address });
      const data = tx.encodeABI();
      const txData = {
        from: account.address,
        to: UNISWAP_ROUTER,
        data,
        gas
      };
      const receipt = await web3.eth.sendTransaction(txData);
      return { success: true, txid: receipt.transactionHash };
    } else if (network === 'BSC') {
      const web3 = new Web3(BSC_RPC);
      const account = web3.eth.accounts.privateKeyToAccount(priv);
      web3.eth.accounts.wallet.add(account);
      // Approve Pancake router to spend the token
      const token = new web3.eth.Contract(ERC20_ABI, tokenAddress);
      const decimals = await token.methods.decimals().call();
      const tokenBalance = await token.methods.balanceOf(account.address).call();
      const approveAmount = tokenBalance; // Approve all tokens
      await token.methods.approve(PANCAKE_ROUTER, approveAmount).send({ from: account.address });
      // Swap tokens for BNB
      const router = new web3.eth.Contract(PANCAKE_ROUTER_ABI, PANCAKE_ROUTER);
      const path = [tokenAddress, WBNB];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
      // Get expected amountOutMin using router.getAmountsOut
      let amountsOut;
      try {
        amountsOut = await router.methods.getAmountsOut(approveAmount, path).call();
      } catch (e) {
        return { success: false, error: 'Failed to fetch price for slippage calculation.' };
      }
      let amountOutMin = amountsOut[1] - (amountsOut[1] * slippage / 100);
      amountOutMin = Math.floor(amountOutMin);
      const tx = router.methods.swapExactTokensForETH(
        approveAmount, // amountIn
        amountOutMin, // amountOutMin
        path,
        account.address, // to: self
        deadline
      );
      const gas = await tx.estimateGas({ from: account.address });
      const data = tx.encodeABI();
      const txData = {
        from: account.address,
        to: PANCAKE_ROUTER,
        data,
        gas
      };
      const receipt = await web3.eth.sendTransaction(txData);
      return { success: true, txid: receipt.transactionHash };
    } else if (network === 'Solana') {
      // --- Raydium swap: token -> SOL ---
      const conn = new SolanaConnection(SOLANA_RPC, 'confirmed');
      const from = SolanaKeypair.fromSecretKey(Buffer.from(priv, 'hex'));
      // Find Raydium pool for SOL/token
      const poolsResp = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
      const pools = await poolsResp.json();
      const poolInfo = Object.values(pools.pools).find(
        (p) => (p.baseMint === tokenAddress || p.quoteMint === tokenAddress) && (p.baseMint === 'So11111111111111111111111111111111111111112' || p.quoteMint === 'So11111111111111111111111111111111111111112')
      );
      if (!poolInfo) return { success: false, error: 'No Raydium pool found for this token.' };
      const poolKeys = jsonInfo2PoolKeys(poolInfo);
      // Prepare swap
      const inToken = poolKeys.baseMint === tokenAddress ? poolKeys.base : poolKeys.quote;
      const outToken = poolKeys.baseMint === 'So11111111111111111111111111111111111111112' ? poolKeys.base : poolKeys.quote;
      const inAmount = new TokenAmount(new RayToken(inToken.mint, inToken.decimals), Math.floor(amount * 10 ** inToken.decimals));
      // Estimate minOutAmount with slippage
      let minOutAmount = 1;
      try {
        minOutAmount = Math.floor(inAmount.raw * (1 - slippage / 100));
      } catch (e) {
        minOutAmount = 1;
      }
      const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
        poolKeys,
        userKeys: {
          tokenAccounts: await getAssociatedTokenAddress(
            new SolanaPublicKey(outToken.mint),
            from.publicKey
          ),
          owner: from.publicKey,
          payer: from.publicKey,
        },
        amountIn: inAmount.raw,
        amountOut: minOutAmount,
        fixedSide: 'in',
        connection: conn,
        makeTxVersion: 0,
      });
      const tx = new Transaction();
      for (const ix of innerTransactions[0].instructions) tx.add(ix);
      tx.feePayer = from.publicKey;
      tx.recentBlockhash = (await conn.getRecentBlockhash()).blockhash;
      const sig = await conn.sendTransaction(tx, [from]);
      await conn.confirmTransaction(sig);
      return { success: true, txid: sig };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// --- Custom Keyboards and Inline Menus ---
const MAIN_MENU = Markup.keyboard([
  ['🪪 Generate Wallet'],
  ['🔗 Enter Token Mint Address'],
  ['👛 Show Wallets'],
  ['Back to Main']
]).resize();

const ENTER_TOKEN_MENU = Markup.keyboard([
  ['🔗 Enter Token Mint Address'],
  ['👛 Show Wallets'],
  ['Back to Main']
]).resize();

const START_VOLUME_MENU = Markup.keyboard([
  ['🚀 Start Volume Bot'],
  ['👛 Show Wallets'],
  ['Back to Main']
]).resize();

function getBuySellMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Buy', 'buy_tokens')],
    [Markup.button.callback('Dump It', 'dump_tokens')],
    [Markup.button.callback('TRX', 'trx_buy')],
    [Markup.button.callback('👛 Show Wallets', 'show_wallets_inline')],
    [Markup.button.callback('Back to Main', 'back_to_main_inline')]
  ]);
}

function getTrxSellMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('TRX Sell', 'trx_sell')],
    [Markup.button.callback('👛 Show Wallets', 'show_wallets_inline')],
    [Markup.button.callback('Back to Main', 'back_to_main_inline')]
  ]);
}

// --- Safe HTML Reply Helper ---
async function safeReplyWithHTML(ctx, message, keyboard) {
  try {
    await ctx.replyWithHTML(message, keyboard);
  } catch (err) {
    console.error('Telegram HTML error:', err);
    await ctx.reply('⚠️ Sorry, there was a problem displaying the message. Please check your input or try again.', keyboard);
  }
}

// --- Show Wallets Handler ---
bot.hears('👛 Show Wallets', async (ctx) => {
  const session = getUserSession(ctx);
  let msg = '<b>Your wallets by network:</b>\n';
  let hasWallets = false;
  for (const net of NETWORKS) {
    const wallets = session.wallets && session.wallets[net] ? session.wallets[net] : [];
    if (wallets.length) {
      hasWallets = true;
      msg += `\n<b>${net}:</b>\n`;
      for (let w of wallets) {
        let bal = await getWalletBalance(net, w.public);
        msg += `<code>${w.public}</code>\nBalance: <b>${bal}</b>\n`;
      }
    }
  }
  if (!hasWallets) {
    return safeReplyWithHTML(ctx, 'No wallets generated yet.', MAIN_MENU);
  }
  safeReplyWithHTML(ctx, msg, MAIN_MENU);
});

bot.action('show_wallets_inline', async (ctx) => {
  const session = getUserSession(ctx);
  let msg = '<b>Your wallets by network:</b>\n';
  let hasWallets = false;
  for (const net of NETWORKS) {
    const wallets = session.wallets && session.wallets[net] ? session.wallets[net] : [];
    if (wallets.length) {
      hasWallets = true;
      msg += `\n<b>${net}:</b>\n`;
      for (let w of wallets) {
        let bal = await getWalletBalance(net, w.public);
        msg += `<code>${w.public}</code>\nBalance: <b>${bal}</b>\n`;
      }
    }
  }
  if (!hasWallets) {
    await safeReplyWithHTML(ctx, 'No wallets generated yet.', MAIN_MENU);
    return ctx.answerCbQuery();
  }
  await safeReplyWithHTML(ctx, msg, MAIN_MENU);
  ctx.answerCbQuery();
});

// --- Start Command ---
bot.start((ctx) => {
  const session = getUserSession(ctx);
  session.step = undefined;
  session.lastStep = undefined;
  safeReplyWithHTML(ctx,
    '👋 <b>Welcome to Volume Bot!</b>\nAutomate volume on <b>Solana</b>, <b>BSC</b>, and <b>Ethereum</b> tokens.\n\nStep 1: Generate wallets to begin.',
    MAIN_MENU
  );
});

bot.command('start', (ctx) => {
  const session = getUserSession(ctx);
  session.step = undefined;
  session.lastStep = undefined;
  safeReplyWithHTML(ctx,
    '👋 <b>Welcome to Volume Bot!</b>\nAutomate volume on <b>Solana</b>, <b>BSC</b>, and <b>Ethereum</b> tokens.\n\nStep 1: Generate wallets to begin.',
    MAIN_MENU
  );
});

// --- Back to Main and Go Back Logic ---
bot.hears('Back to Main', (ctx) => {
  const session = getUserSession(ctx);
  session.lastStep = session.step;
  session.step = undefined;
  safeReplyWithHTML(ctx, 'Back to main menu.', MAIN_MENU);
  userSessions[ctx.from.id] = session;
});

bot.action('back_to_main_inline', (ctx) => {
  const session = getUserSession(ctx);
  session.lastStep = session.step;
  session.step = undefined;
  safeReplyWithHTML(ctx, 'Back to main menu.', MAIN_MENU);
  userSessions[ctx.from.id] = session;
  ctx.answerCbQuery();
});

// --- Generate Wallet Flow ---
bot.hears('🪪 Generate Wallet', (ctx) => {
  const session = getUserSession(ctx);
  session.lastStep = session.step;
  session.step = 'await_wallet_count';
  safeReplyWithHTML(ctx, 'How many wallets do you want to generate? (Recommended: 5, Max: 20)', Markup.keyboard([
    ['Back to Main']
  ]).resize());
  userSessions[ctx.from.id] = session;
});

// --- Enter Token Mint Address ---
bot.hears('🔗 Enter Token Mint Address', (ctx) => {
  console.log('Enter Token Mint Address button clicked by user:', ctx.from.id);
  safeReplyWithHTML(ctx, 'Please enter the token mint address below and then press enter.', Markup.keyboard([
    ['Back to Main']
  ]).resize());
  const session = getUserSession(ctx);
  session.lastStep = session.step;
  session.step = 'await_token_address';
});

bot.command('entertoken', (ctx) => {
  console.log('/entertoken command triggered by user:', ctx.from.id);
  safeReplyWithHTML(ctx, 'Please enter the token mint address below and then press enter.', Markup.keyboard([
    ['Back to Main']
  ]).resize());
  const session = getUserSession(ctx);
  session.lastStep = session.step;
  session.step = 'await_token_address';
});

// --- Start Volume Bot ---
bot.hears('🚀 Start Volume Bot', async (ctx) => {
  const session = getUserSession(ctx);
  if (!session.tradeNetwork) {
    safeReplyWithHTML(ctx, 'Please enter a token mint address first.', START_VOLUME_MENU);
    return;
  }
  if (!session.tokenAddress) {
    safeReplyWithHTML(ctx, 'Please enter a token mint address first.', START_VOLUME_MENU);
    return;
  }
  const wallets = (session.wallets && session.wallets[session.tradeNetwork]) || [];
  if (!wallets.length) {
    safeReplyWithHTML(ctx, 'No wallets generated for this network. Please generate wallets first.', MAIN_MENU);
    return;
  }
  // Check FIRST wallet balance
  let firstWalletBal = await getWalletBalance(session.tradeNetwork, wallets[0].public);
  if (firstWalletBal === 'Error' || parseFloat(firstWalletBal) < 0.01) {
    safeReplyWithHTML(ctx, '❌ <b>Insufficient funds in your wallet. Please fund your wallet before starting.</b>', START_VOLUME_MENU);
    return;
  }
  // Check all wallet balances
  let allOk = true;
  let anyFunded = false;
  for (let w of wallets) {
    let bal = await getWalletBalance(session.tradeNetwork, w.public);
    if (bal !== 'Error' && parseFloat(bal) >= 0.01) anyFunded = true;
    if (bal === 'Error' || parseFloat(bal) < 0.01) allOk = false;
  }
  if (!anyFunded) {
    session.activeVolume = session.activeVolume || {};
    session.activeVolume[session.tradeNetwork] = false;
    safeReplyWithHTML(ctx, '❌ <b>All wallets have zero or insufficient balance. Please fund your wallets before starting volume bot.</b>', START_VOLUME_MENU);
    return;
  }
  if (!allOk) {
    safeReplyWithHTML(ctx, '❌ <b>Some wallets are not funded. Please fund your wallets before starting volume bot.</b>', START_VOLUME_MENU);
    return;
  }
  // Always show speed selection if not set
  if (!session.selectedSpeed) {
    safeReplyWithHTML(ctx, 'Choose transaction speed:', getSpeedMenu());
    return;
  }
  // Ask for slippage
  session.step = 'await_slippage';
  safeReplyWithHTML(ctx, 'Enter slippage % (e.g. 0.5 for 0.5%, max 50, min 0.1, default 1):', Markup.keyboard([
    ['Use Default (1%)'],
    ['Back to Main']
  ]).resize());
  userSessions[ctx.from.id] = session;
});

// --- Await Slippage Step ---
bot.on('text', async (ctx) => {
  const session = getUserSession(ctx);
  if (ctx.message.text === 'Back to Main') {
    session.lastStep = session.step;
    session.step = undefined;
    safeReplyWithHTML(ctx, 'Back to main menu.', MAIN_MENU);
    userSessions[ctx.from.id] = session;
    return;
  }
  if (ctx.message.text === 'Go Back' && session.lastStep) {
    session.step = session.lastStep;
    safeReplyWithHTML(ctx, 'Returning to previous step...', Markup.keyboard([
      ['Back to Main']
    ]).resize());
    userSessions[ctx.from.id] = session;
    return;
  }
  if (session.step === 'await_slippage') {
    let slippage = 1;
    if (ctx.message.text === 'Use Default (1%)') {
      slippage = 1;
    } else {
      slippage = parseFloat(ctx.message.text);
      if (isNaN(slippage) || slippage < 0.1 || slippage > 50) {
        safeReplyWithHTML(ctx, 'Please enter a valid slippage between 0.1 and 50.', Markup.keyboard([
          ['Use Default (1%)'],
          ['Back to Main']
        ]).resize());
        return;
      }
    }
    session.slippage = slippage;
    session.step = 'await_buy_amount';
    userSessions[ctx.from.id] = session;
    safeReplyWithHTML(ctx, `Slippage set to <b>${slippage}%</b>.\nHow much ${session.tradeNetwork === 'Ethereum' ? 'ETH' : session.tradeNetwork === 'BSC' ? 'BNB' : 'SOL'} do you want to use for each buy transaction? (Default: 0.001)`, Markup.keyboard([
      ['Use Default (0.001)'],
      ['Back to Main']
    ]).resize());
    return;
  }
  if (session.step === 'await_buy_amount') {
    let amount = 0.001;
    if (ctx.message.text === 'Use Default (0.001)') {
      amount = 0.001;
    } else {
      amount = parseFloat(ctx.message.text);
      if (isNaN(amount) || amount < 0.0001 || amount > 10.0) {
        safeReplyWithHTML(ctx, 'Please enter a valid amount between 0.0001 and 10.0.', Markup.keyboard([
          ['Use Default (0.001)'],
          ['Back to Main']
        ]).resize());
        return;
      }
    }
    session.buyAmount = amount;
    session.step = undefined;
    userSessions[ctx.from.id] = session;
    safeReplyWithHTML(ctx, `Amount per buy transaction set to <b>${amount}</b> ${session.tradeNetwork === 'Ethereum' ? 'ETH' : session.tradeNetwork === 'BSC' ? 'BNB' : 'SOL'}.\nYou can now Buy or Dump tokens.`, getBuySellMenu());
    return;
  }
  if (session.step === 'await_wallet_count') {
    let count = parseInt(ctx.message.text);
    if (isNaN(count) || count < 1 || count > 20) {
      return safeReplyWithHTML(ctx, 'Please enter a valid number between 1 and 20.', Markup.keyboard([
        ['Back to Main']
      ]).resize());
    }
    session.walletCount = count;
    session.lastStep = session.step;
    session.step = 'await_wallet_network';
    safeReplyWithHTML(ctx, 'Select the network for wallet generation:', Markup.keyboard([
      NETWORKS,
      ['Back to Main']
    ]).resize());
    userSessions[ctx.from.id] = session;
    return;
  }
  if (session.step === 'await_wallet_network') {
    if (!NETWORKS.includes(ctx.message.text)) {
      return safeReplyWithHTML(ctx, 'Please select a valid network.', Markup.keyboard([
        ['Back to Main']
      ]).resize());
    }
    session.walletNetwork = ctx.message.text;
    let wallets = [];
    if (session.walletNetwork === 'Solana') {
      for (let i = 0; i < session.walletCount; i++) {
        const kp = SolanaKeypair.generate();
        wallets.push({ public: kp.publicKey.toBase58(), private: Buffer.from(kp.secretKey).toString('hex') });
      }
    } else if (session.walletNetwork === 'Ethereum' || session.walletNetwork === 'BSC') {
      for (let i = 0; i < session.walletCount; i++) {
        const web3 = new Web3();
        const acc = web3.eth.accounts.create();
        wallets.push({ public: acc.address, private: acc.privateKey });
      }
    }
    if (!session.wallets) session.wallets = {};
    session.wallets[session.walletNetwork] = wallets;
    userSessions[ctx.from.id] = session;
    safeReplyWithHTML(
      ctx,
      `<b>${session.walletCount} wallets generated on ${session.walletNetwork}:</b>\n\n${formatWalletList(wallets, session.walletNetwork)}`,
      ENTER_TOKEN_MENU
    );
    session.lastStep = session.step;
    session.step = undefined;
    safeReplyWithHTML(ctx, 'Please fund your wallets and enter the token mint address to start the volume bot.', ENTER_TOKEN_MENU);
    return;
  }
  if (session.step === 'await_token_address') {
    console.log('await_token_address handler triggered for user:', ctx.from.id, 'input:', ctx.message.text);
    // Use Dex Screener API to detect network
    let net = null;
    let price = 'N/A', volume = 'N/A', found = false, chainName = '', tokenName = '', tokenSymbol = '';
    try {
      const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ctx.message.text}`);
      const data = await resp.json();
      if (data.pairs && data.pairs.length > 0) {
        // Use the first pair's chainId or chainName for network detection
        const pair = data.pairs[0];
        if (pair.chainId) {
          if (pair.chainId.toLowerCase().includes('bsc')) net = 'BSC';
          else if (pair.chainId.toLowerCase().includes('eth')) net = 'Ethereum';
          else if (pair.chainId.toLowerCase().includes('sol')) net = 'Solana';
          chainName = pair.chainId;
        } else if (pair.chainName) {
          if (pair.chainName.toLowerCase().includes('bsc')) net = 'BSC';
          else if (pair.chainName.toLowerCase().includes('eth')) net = 'Ethereum';
          else if (pair.chainName.toLowerCase().includes('sol')) net = 'Solana';
          chainName = pair.chainName;
        }
        if (pair.baseToken) {
          tokenName = pair.baseToken.name || '';
          tokenSymbol = pair.baseToken.symbol || '';
        }
        if (pair.priceUsd && pair.volume && pair.volume.h24) {
          price = pair.priceUsd;
          volume = pair.volume.h24;
          found = true;
        }
      }
    } catch (e) {
      console.error('Error fetching from Dex Screener:', e);
      safeReplyWithHTML(ctx, 'An error occurred while checking the token address. Please try again later or check your address.', ENTER_TOKEN_MENU);
      return;
    }
    if (!net) {
      safeReplyWithHTML(ctx, 'Could not detect network from Dex Screener. Please check the address and try again.', ENTER_TOKEN_MENU);
      return;
    }
    session.tokenAddress = ctx.message.text;
    session.tradeNetwork = net;
    // --- Compose visually appealing message ---
    let msg = `<b>🎯 Token address set:</b> <code>${session.tokenAddress}</code>\n`;
    msg += `<b>🌐 Detected network:</b> <b>${net}</b> <i>(${chainName})</i>\n`;
    if (tokenName || tokenSymbol) {
      msg += `🔹 <b>Token:</b> <b>${tokenName}${tokenSymbol ? ' (' + tokenSymbol + ')' : ''}</b>\n`;
    }
    if (found) {
      msg += `💲 <b>Price:</b> <b>$${price}</b>\n📊 <b>24h Volume:</b> <b>${volume}</b>\n`;
    } else {
      msg += `<b>Price and volume not found on Dex Screener.</b>\n`;
    }
    // Show wallets for this network
    const wallets = (session.wallets && session.wallets[net]) || [];
    if (wallets.length) {
      msg += `\n<b>👛 Your ${net} wallets:</b>\n`;
      for (let i = 0; i < wallets.length; i++) {
        let bal = await getWalletBalance(net, wallets[i].public);
        msg += `#${i+1} <code>${wallets[i].public}</code>\n`;
        msg += `   <b>Balance:</b> <code>${bal}</code>\n`;
      }
    } else {
      msg += `\n<b>⚠️ No wallets found for ${net}. Please generate wallets first.</b>\n`;
    }
    msg += '\n<b>➡️ Next:</b> Click <b>Start Volume Bot</b> to begin.';
    safeReplyWithHTML(ctx, msg, START_VOLUME_MENU);
    session.lastStep = session.step;
    session.step = undefined;
    userSessions[ctx.from.id] = session;
    return;
  }
  // Fallback: unknown input or out-of-sequence
  safeReplyWithHTML(ctx, 'Sorry, I did not understand that. Please use the menu below.', MAIN_MENU);
  session.lastStep = session.step;
  session.step = undefined;
  userSessions[ctx.from.id] = session;
});

bot.on('callback_query', async (ctx) => {
  const session = getUserSession(ctx);
  const data = ctx.callbackQuery.data;
  if (data === 'buy_tokens') {
    if (!session.buySellReady) {
      ctx.answerCbQuery('Please start the volume bot first.');
      return;
    }
    // --- Buy Logic (real transactions) ---
    const wallets = (session.wallets && session.wallets[session.tradeNetwork]) || [];
    let txPerWalletPerRound = 1;
    if (session.selectedSpeed && session.selectedSpeed.value === 'moderate') txPerWalletPerRound = 2;
    if (session.selectedSpeed && session.selectedSpeed.value === 'fast') txPerWalletPerRound = 4;
    const totalTx = wallets.length * (session.selectedSpeed ? session.selectedSpeed.rate : 4);
    const rounds = Math.ceil((session.selectedSpeed ? session.selectedSpeed.rate : 4) / txPerWalletPerRound);
    let sent = 0;
    session.lastTxs = session.lastTxs || {};
    session.lastTxs[session.tradeNetwork] = [];
    const buyAmount = session.buyAmount || 0.001;
    const slippage = session.slippage || 1;
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < wallets.length; i++) {
        for (let t = 0; t < txPerWalletPerRound; t++) {
          if (sent >= totalTx) break;
          // Send real buy transaction
          const result = await sendBuyTx(session.tradeNetwork, wallets[i].private, session.tokenAddress, buyAmount, slippage);
          if (result.success) {
            let explorer = session.tradeNetwork === 'Ethereum' ? 'https://etherscan.io/tx/' : session.tradeNetwork === 'BSC' ? 'https://bscscan.com/tx/' : 'https://solscan.io/tx/';
            session.lastTxs[session.tradeNetwork].push(explorer + result.txid);
          } else {
            session.lastTxs[session.tradeNetwork].push('Error: ' + result.error);
          }
          sent++;
        }
      }
      safeReplyWithHTML(ctx, `<b>${sent}/${totalTx}</b> buy transactions sent...`, getBuySellMenu());
      if (sent < totalTx) {
        await new Promise(r => setTimeout(r, 20000));
      }
    }
    safeReplyWithHTML(ctx, '✅ <b>Buy operation complete!</b> You can now Dump tokens or check TRX.', getBuySellMenu());
    ctx.answerCbQuery('Buy complete!');
  } else if (data === 'dump_tokens') {
    if (!session.buySellReady) {
      ctx.answerCbQuery('Please start the volume bot first.');
      return;
    }
    // --- Sell Logic (real transactions, with gas safety check) ---
    const wallets = (session.wallets && session.wallets[session.tradeNetwork]) || [];
    let txPerWalletPerRound = 1;
    if (session.selectedSpeed && session.selectedSpeed.value === 'moderate') txPerWalletPerRound = 2;
    if (session.selectedSpeed && session.selectedSpeed.value === 'fast') txPerWalletPerRound = 4;
    const totalTx = wallets.length * (session.selectedSpeed ? session.selectedSpeed.rate : 4);
    const rounds = Math.ceil((session.selectedSpeed ? session.selectedSpeed.rate : 4) / txPerWalletPerRound);
    let sent = 0;
    session.lastSellTxs = session.lastSellTxs || {};
    session.lastSellTxs[session.tradeNetwork] = [];
    const buyAmount = session.buyAmount || 0.001;
    const slippage = session.slippage || 1;
    let skippedWallets = [];
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < wallets.length; i++) {
        for (let t = 0; t < txPerWalletPerRound; t++) {
          if (sent >= totalTx) break;
          // Check native balance for gas safety
          let nativeBal = await getWalletBalance(session.tradeNetwork, wallets[i].public);
          if (nativeBal === 'Error' || parseFloat(nativeBal) < 0.002) {
            skippedWallets.push(wallets[i].public);
            session.lastSellTxs[session.tradeNetwork].push(`Skipped (low balance): <code>${wallets[i].public}</code>`);
            continue;
          }
          // Send real sell transaction
          const result = await sendSellTx(session.tradeNetwork, wallets[i].private, session.tokenAddress, buyAmount, slippage);
          if (result.success) {
            let explorer = session.tradeNetwork === 'Ethereum' ? 'https://etherscan.io/tx/' : session.tradeNetwork === 'BSC' ? 'https://bscscan.com/tx/' : 'https://solscan.io/tx/';
            session.lastSellTxs[session.tradeNetwork].push(explorer + result.txid);
          } else {
            session.lastSellTxs[session.tradeNetwork].push('Error: ' + result.error);
          }
          sent++;
        }
      }
      safeReplyWithHTML(ctx, `<b>${sent}/${totalTx}</b> sell transactions sent...`, getTrxSellMenu());
      if (sent < totalTx) {
        await new Promise(r => setTimeout(r, 20000));
      }
    }
    let summary = '✅ <b>Dump successful. Bot stopped.</b> See TRX Sell for details.';
    if (skippedWallets.length) {
      summary += `\n\n<b>Skipped wallets (low balance):</b>\n`;
      for (const w of skippedWallets) summary += `<code>${w}</code>\n`;
    }
    safeReplyWithHTML(ctx, summary, getTrxSellMenu());
    session.activeVolume[session.tradeNetwork] = false;
    session.buySellReady = false;
    ctx.answerCbQuery('Dump complete!');
  } else if (data === 'trx_buy') {
    // ... existing code ...
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM')); 