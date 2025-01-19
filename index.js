const { ethers } = require("ethers");
const pLimit = require("p-limit").default;

// Configuration
const CONFIG = {
  BAYC_CONTRACT_ADDRESS: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
  ETHEREUM_RPC_URL: "https://eth-mainnet.public.blastapi.io",
  CONCURRENT_REQUESTS: 25,
  OWNER_BATCH_SIZE: 150,
  BALANCE_BATCH_SIZE: 75,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  PERFORMANCE_LOGGING: true,
};

const provider = new ethers.JsonRpcProvider(
  CONFIG.ETHEREUM_RPC_URL,
  undefined,
  {
    maxRetries: CONFIG.RETRY_ATTEMPTS,
    retryDelay: CONFIG.RETRY_DELAY,
  },
);

const BAYC_ABI = [
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];

class PerformanceTracker {
  constructor() {
    this.startTime = 0;
    this.checkpoints = new Map();
  }

  start() {
    this.startTime = performance.now();
  }

  checkpoint(name) {
    this.checkpoints.set(name, performance.now() - this.startTime);
  }

  getTotalTime() {
    return ((performance.now() - this.startTime) / 1000).toFixed(2);
  }

  printSummary() {
    console.log("\nPerformance Summary:");
    this.checkpoints.forEach((time, name) => {
      console.log(`${name}: ${(time / 1000).toFixed(2)}s`);
    });
    console.log(`Total Time: ${this.getTotalTime()}s`);
  }
}

async function withRetry(fn, retries = CONFIG.RETRY_ATTEMPTS) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      // Check if the error is about a non-existent token
      if (error.reason === "ERC721: owner query for nonexistent token") {
        return null; // Skip non-existent tokens
      }

      lastError = error;
      if (i === retries - 1) throw error;
      const delay = CONFIG.RETRY_DELAY * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size),
  );

class BAYCHoldersAnalyzer {
  constructor() {
    this.limit = pLimit(CONFIG.CONCURRENT_REQUESTS);
    this.contract = new ethers.Contract(
      CONFIG.BAYC_CONTRACT_ADDRESS,
      BAYC_ABI,
      provider,
    );
    this.performanceTracker = new PerformanceTracker();
  }

  async getUniqueHolders() {
    this.performanceTracker.checkpoint("Start getUniqueHolders");
    const totalSupply = await this.contract.totalSupply();
    const uniqueHolders = new Set();

    const totalSupplyNum = Number(totalSupply);
    const tokenIds = Array.from({ length: totalSupplyNum }, (_, i) => i + 1);
    const batches = chunk(tokenIds, CONFIG.OWNER_BATCH_SIZE);

    let processedTokens = 0;
    let skippedTokens = 0;

    for (const batch of batches) {
      const ownerPromises = batch.map((tokenId) =>
        this.limit(() => withRetry(() => this.contract.ownerOf(tokenId))),
      );

      const owners = await Promise.all(ownerPromises);
      owners.forEach((owner) => {
        if (owner === null) {
          skippedTokens++;
        } else {
          uniqueHolders.add(owner);
        }
      });

      processedTokens += batch.length;
      if (CONFIG.PERFORMANCE_LOGGING) {
        const progress = (
          (Number(processedTokens) / Number(totalSupplyNum)) *
          100
        ).toFixed(1);
        console.log(
          `Progress: ${progress}% (${processedTokens - skippedTokens} valid tokens/${processedTokens} processed/${totalSupplyNum} total)`,
        );
      }
    }

    if (skippedTokens > 0) {
      console.log(`\nSkipped ${skippedTokens} non-existent tokens`);
    }

    this.performanceTracker.checkpoint("End getUniqueHolders");
    return [...uniqueHolders];
  }

  async calculateTotalETHForHolders(epochTime) {
    this.performanceTracker.start();
    const uniqueHolders = await this.getUniqueHolders();
    this.performanceTracker.checkpoint("Holders Retrieved");

    console.log(`\nProcessing ${uniqueHolders.length} unique holders`);
    const batches = chunk(uniqueHolders, CONFIG.BALANCE_BATCH_SIZE);
    let totalETH = BigInt(0);
    let processedHolders = 0;
    let failedBalanceChecks = 0;

    for (const batch of batches) {
      const balancePromises = batch.map((address) =>
        this.limit(() => withRetry(() => provider.getBalance(address))),
      );

      const balances = await Promise.all(balancePromises);
      balances.forEach((balance) => {
        if (balance === null) {
          failedBalanceChecks++;
        } else {
          totalETH += BigInt(balance);
        }
      });

      processedHolders += batch.length;
      if (CONFIG.PERFORMANCE_LOGGING) {
        const progress = (
          (processedHolders / uniqueHolders.length) *
          100
        ).toFixed(1);
        console.log(
          `Balance Progress: ${progress}% (${processedHolders - failedBalanceChecks} successful/${processedHolders} processed)`,
        );
      }
    }

    if (failedBalanceChecks > 0) {
      console.log(
        `\nFailed to get balance for ${failedBalanceChecks} addresses`,
      );
    }

    const formattedTotal = ethers.formatEther(totalETH);
    this.performanceTracker.checkpoint("Balances Retrieved");

    if (CONFIG.PERFORMANCE_LOGGING) {
      this.performanceTracker.printSummary();
    }

    return formattedTotal;
  }
}

async function main() {
  try {
    console.log("Starting analysis with optimized settings...");
    const startTime = performance.now();

    const analyzer = new BAYCHoldersAnalyzer();
    const epochTime = 1672531200;
    const total = await analyzer.calculateTotalETHForHolders(epochTime);

    const totalTime = (performance.now() - startTime) / 1000;
    console.log(`\nResults:`);
    console.log(`Total ETH at epoch ${epochTime}: ${total} ETH`);
    console.log(`Total execution time: ${totalTime.toFixed(2)} seconds`);
  } catch (error) {
    console.error("Error in main:", error);
    if (error.reason) console.error("Reason:", error.reason);
    if (error.shortMessage) console.error("Short message:", error.shortMessage);
  }
}

main();
