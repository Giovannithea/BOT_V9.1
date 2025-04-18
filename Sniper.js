const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { swapTokens } = require('./SwapCreator');
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
const bs58 = require('bs58');
require('dotenv').config();

class Sniper {
    constructor(config) {
        this.tokenId = config.tokenId; // MongoDB document ID
        this.baseToken = config.baseToken;
        this.targetToken = config.targetToken;
        this.buyAmount = config.buyAmount; // Raw integer amount in lamports
        this.sellTargetPercentage = config.sellTargetPrice;
        this.tokenData = config.tokenData;
        this.connection = new Connection(process.env.SOLANA_WS_URL, 'confirmed');

        // Decimal handling for display
        this.decimals = config.tokenData.decimals || 9;
        this.formattedAmount = this.buyAmount / 10 ** this.decimals; // Convert to SOL or token units

        // Get user wallet with bs58 fix
        this.userOwner = Keypair.fromSecretKey(
            bs58.default.decode(process.env.WALLET_PRIVATE_KEY)
        );

        // Derive proper token accounts based on the token data
        this.userSource = getAssociatedTokenAddressSync(
            new PublicKey(this.tokenData.quoteMint), // For buying, source is quote mint (usually SOL)
            this.userOwner.publicKey
        ).toString();

        this.userDestination = getAssociatedTokenAddressSync(
            new PublicKey(this.tokenData.baseMint), // For buying, destination is base mint (token)
            this.userOwner.publicKey
        ).toString();

        // Price calculation variables
        this.K = Number(config.tokenData.K) || 0;
        this.V = Number(config.tokenData.V) || 0;
        this.calculatedSellPrice = this.V * (1 + (this.sellTargetPercentage / 100));

        console.log(`Initialized sniper for token ${this.targetToken} with K=${this.K}, V=${this.V}`);
        console.log(`Sell target price: ${this.calculatedSellPrice}`);
    }

    setBuyAmount(amount) {
        this.buyAmount = amount;
        this.formattedAmount = amount / 10 ** this.decimals; // Update formatted amount
    }

    setSellTargetPrice(percentage) {
        this.sellTargetPercentage = percentage;
        this.calculatedSellPrice = this.V * (1 + (percentage / 100));
    }

    async watchPrice() {
        console.log(`Watching price for target token: ${this.targetToken}`);
        console.log(`Initial price (V): ${this.V}`);
        console.log(`Target sell price (${this.sellTargetPercentage}% increase): ${this.calculatedSellPrice}`);

        const intervalId = setInterval(async () => {
            try {
                const currentPrice = await this.getCurrentPrice();
                console.log(`Current price of ${this.targetToken}: ${currentPrice}`);
                if (currentPrice >= this.calculatedSellPrice) {
                    await this.sellToken();
                    clearInterval(intervalId);
                }
            } catch (error) {
                console.error("Error watching price:", error);
            }
        }, 60000);
    }

    async getCurrentPrice() {
        try {
            const currentBalance = await this.getLiquidityBalance();
            return this.calculatePrice(currentBalance);
        } catch (error) {
            console.error("Error getting current price:", error);
            return 0;
        }
    }

    calculatePrice(currentBalance) {
        if (!currentBalance || currentBalance === 0) return 0;
        const X = this.K / currentBalance;
        const price = currentBalance / X;
        return price;
    }

    async getLiquidityBalance() {
        try {
            const quoteVault = new PublicKey(this.tokenData.quoteVault);
            const accountInfo = await this.connection.getAccountInfo(quoteVault);
            if (accountInfo) {
                const balance = accountInfo.lamports / 10 ** 9; // Convert lamports to SOL
                return balance;
            }
            throw new Error(`Unable to fetch liquidity balance for quoteVault ${this.tokenData.quoteVault}`);
        } catch (error) {
            console.error("Error getting liquidity balance:", error);
            throw error;
        }
    }

    async buyToken() {
        try {
            console.log(`Initiating buy for ${this.formattedAmount} tokens of ${this.targetToken}`);

            // Validate buy amount
            if (this.buyAmount <= 0 || this.buyAmount > 10 ** 12) {
                throw new Error(`Invalid buy amount: ${this.buyAmount}`);
            }

            const swapResult = await swapTokens({
                tokenId: this.tokenId, // Pass MongoDB ID
                amountSpecified: this.buyAmount, // Raw integer amount in lamports
                swapBaseIn: true
            });

            console.log(`Buy transaction successful: ${swapResult}`);
            return swapResult;
        } catch (error) {
            console.error('Buy failed:', error.message);
            throw error;
        }
    }

    async sellToken() {
        try {
            console.log(`Selling ${this.targetToken} at target price ${this.calculatedSellPrice}`);

            const swapResult = await swapTokens({
                tokenId: this.tokenId, // Pass MongoDB ID
                amountSpecified: this.buyAmount, // Raw integer amount in lamports
                swapBaseIn: false
            });

            console.log(`Sell transaction successful: ${swapResult}`);
            return swapResult;
        } catch (error) {
            console.error('Sell failed:', error.message);
            throw error;
        }
    }

    async subscribeToVault() {
        try {
            const quoteVault = new PublicKey(this.tokenData.quoteVault);
            this.vaultSubscriptionId = this.connection.onAccountChange(quoteVault, (accountInfo) => {
                const balance = accountInfo.lamports / 10 ** 9; // Convert lamports to SOL
                console.log(`Updated balance for quoteVault ${this.tokenData.quoteVault}: ${balance}`);
                const price = this.calculatePrice(balance);
                console.log(`Calculated price based on updated balance: ${price}`);

                if (price >= this.calculatedSellPrice) {
                    this.sellToken()
                        .then(() => this.unsubscribeFromVault())
                        .catch(error => console.error('Error during sale:', error));
                }
            });
            console.log(`Subscribed to account changes for quoteVault ${this.tokenData.quoteVault}`);
        } catch (error) {
            console.error("Error subscribing to vault:", error);
        }
    }

    async unsubscribeFromVault() {
        if (this.vaultSubscriptionId) {
            try {
                await this.connection.removeAccountChangeListener(this.vaultSubscriptionId);
                console.log(`Unsubscribed from vault ${this.tokenData.quoteVault}`);
                this.vaultSubscriptionId = null;
            } catch (error) {
                console.error('Error unsubscribing from vault:', error);
            }
        }
    }
}

module.exports = Sniper;