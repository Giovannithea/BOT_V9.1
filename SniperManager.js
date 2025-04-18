const { Connection, PublicKey } = require('@solana/web3.js');
const { Liquidity, Token, TokenAmount } = require('@raydium-io/raydium-sdk-v2');
const { swapTokens } = require('./swapCreator');
require('dotenv').config();

class SniperManager {
    static activeSnipers = new Map();
    static connection = new Connection('https://api.mainnet-beta.solana.com');

    static async addSniper(config) {
        if (this.activeSnipers.has(config.targetToken)) return;

        console.log(`[Sniper] Initializing for token: ${config.targetToken}`);

        const poolKeys = {
            id: new PublicKey(config.poolState.ammId),
            baseMint: new PublicKey(config.poolState.baseMint),
            quoteMint: new PublicKey(config.poolState.quoteMint),
            baseDecimals: config.poolState.baseDecimals,
            quoteDecimals: config.poolState.quoteDecimals,
            // Include all required V2 pool keys from your poolState
        };

        // Immediate first check
        const initialPrice = await this.getTokenPrice(poolKeys);
        console.log(`[Sniper] Initial price: ${initialPrice} SOL`);

        if (initialPrice >= config.sellTargetPrice) {
            console.log(`[Sniper] Price already above target, skipping`);
            return;
        }

        const checkInterval = setInterval(async () => {
            try {
                const currentPrice = await this.getTokenPrice(poolKeys);
                console.log(`[Sniper] Current price: ${currentPrice} SOL`);

                if (currentPrice >= config.sellTargetPrice) {
                    console.log(`[Sniper] Target price reached! Executing sell...`);
                    await this.executeSell(config, poolKeys);
                    clearInterval(checkInterval);
                    this.activeSnipers.delete(config.targetToken);
                }
            } catch (error) {
                console.error(`[Sniper] Price check error:`, error.message);
            }
        }, 3000); // Check every 3 seconds

        this.activeSnipers.set(config.targetToken, {
            config,
            poolKeys,
            interval: checkInterval
        });
    }

    static async getTokenPrice(poolKeys) {
        const poolState = await Liquidity.fetchState({
            connection: this.connection,
            poolKeys,
            version: 0
        });

        // Calculate price using LP reserves with proper decimals
        const baseAmount = poolState.baseReserve.toNumber() / Math.pow(10, poolKeys.baseDecimals);
        const quoteAmount = poolState.quoteReserve.toNumber() / Math.pow(10, poolKeys.quoteDecimals);

        return quoteAmount / baseAmount; // Returns price in quote token (SOL)
    }

    static async executeSell(config, poolKeys) {
        try {
            // Calculate 10% below current price for sell order
            const currentPrice = await this.getTokenPrice(poolKeys);
            const sellPrice = currentPrice * 0.9;

            console.log(`[Sniper] Selling at ${sellPrice} SOL (10% below current)`);

            await swapTokens({
                tokenId: config.poolState._id, // MongoDB document ID
                amountSpecified: config.buyAmount,
                swapBaseIn: false // Selling the token
            });

            console.log(`[Sniper] Sell order executed successfully`);
        } catch (error) {
            console.error(`[Sniper] Sell execution failed:`, error.message);
        }
    }

    static stopAll() {
        this.activeSnipers.forEach(sniper => {
            clearInterval(sniper.interval);
        });
        this.activeSnipers.clear();
    }
}

module.exports = SniperManager;