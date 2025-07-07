# VolumeBot

VolumeBot is a Telegram bot that automates buy/sell volume on Solana, BSC, and Ethereum tokens using multiple wallets. It supports real transactions on Uniswap, PancakeSwap, and Raydium.

---

## Features

- Generate multiple wallets for Solana, BSC, or Ethereum.
- Fund wallets and automate buy/sell transactions for a given token.
- Adjustable transaction speed and slippage.
- Telegram bot interface.

---

## Prerequisites

- Node.js v16 or higher
- npm
- Telegram account (to create a bot and get a token)
- RPC endpoints for Solana, BSC, and Ethereum (QuickNode or similar)

---

## Setup

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd VolumeBot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create a `.env` file

Create a `.env` file in the root directory with the following variables:

```
TOKEN_ADDRESS=your_telegram_bot_token
OWNER_CHAT_ID=your_telegram_user_id
SOL_RPC_URL=https://api.mainnet-beta.solana.com
BSC_RPC_URL=https://bsc-dataseed.binance.org/
QUICKNODE_KEY=your_quicknode_ethereum_key
PORT=3000
```

- `TOKEN_ADDRESS`: Telegram bot token from BotFather
- `OWNER_CHAT_ID`: Your Telegram user ID (for admin features)
- `SOL_RPC_URL`: Solana RPC endpoint
- `BSC_RPC_URL`: BSC RPC endpoint
- `QUICKNODE_KEY`: QuickNode Ethereum key (or compatible endpoint)
- `PORT`: (Optional) HTTP server port (default: 3000)

### 4. Start the bot

```bash
npm start
```

---

## Usage

1. **Start the bot**: Open Telegram, search for your bot, and click "Start".
2. **Generate wallets**: Use the menu to generate wallets for Solana, BSC, or Ethereum.
3. **Fund wallets**: Send SOL, BNB, or ETH to the generated wallet addresses.
4. **Enter token address**: Input the token contract/mint address you want to trade.
5. **Start Volume Bot**: Choose transaction speed and slippage, then start the bot.
6. **Buy/Sell**: Use the menu to execute buy or sell operations. The bot will send real transactions from all wallets.

---

## Notes

- **Security**: Private keys are stored in memory only (not persistent). For production, use a secure database.
- **Gas/Fees**: Ensure all wallets are funded with enough native tokens for gas.
- **APIs**: Uses Uniswap (Ethereum), PancakeSwap (BSC), and Raydium (Solana) for swaps.
- **Limitations**: API rate limits, network congestion, or insufficient funds may cause some transactions to fail.

---

## Troubleshooting

- **Bot not responding**: Check your `.env` values and ensure the bot is running.
- **Transactions failing**: Ensure wallets are funded and RPC endpoints are correct.
- **Port in use**: Change the `PORT` variable in your `.env` file.

---

## License

ISC
