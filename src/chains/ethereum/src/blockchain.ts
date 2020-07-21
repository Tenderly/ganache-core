import Miner from "./miner";
import Database from "./database";
import Emittery from "emittery";
import BlockManager, {Block} from "./components/block-manager";
import TransactionManager from "./components/transaction-manager";
import CheckpointTrie from "merkle-patricia-tree";
import {BN} from "ethereumjs-util";
import Account from "./things/account";
import {promisify} from "util";
import {Quantity, Data} from "@ganache/utils/src/things/json-rpc";
import EthereumJsAccount from "ethereumjs-account";
import AccountManager from "./components/account-manager";
import {utils} from "@ganache/utils";
import Transaction from "./things/transaction";
import Manager from "./components/manager";
import TransactionReceipt from "./things/transaction-receipt";
import {encode as rlpEncode} from "rlp";
import Common from "ethereumjs-common";

import VM from "ethereumjs-vm";
import Address from "./things/address";


export enum Status {
  // Flags
  started = 1,		// 0000 0001
  starting = 2,		// 0000 0010
  stopped = 4,		// 0000 0100
  stopping = 8,		// 0000 1000
  paused = 16			// 0001 0000
}

export type BlockchainOptions = {
  db?: string | object;
  db_path?: string;
  initialAccounts?: Account[];
  hardfork?: string;
  allowUnlimitedContractSize?: boolean;
  gasLimit?: Quantity;
  time?: Date;
  blockTime?: number;
  coinbase: Account;
};

export default class Blockchain extends Emittery {
  #state: Status = Status.starting;
  public blocks: BlockManager;
  public transactions: TransactionManager;
  public transactionReceipts: Manager<TransactionReceipt>;
  public accounts: AccountManager;
  public vm: VM;
  public trie: CheckpointTrie;
  readonly #database: Database;

  /**
   * Initializes the underlying Database and handles synchronization between
   * the ledger and the database.
   *
   * Emits a `ready` event once the database and
   * all dependencies are fully initialized.
   * @param options
   */
  constructor(options: BlockchainOptions) {
    super();

    const database = (this.#database = new Database(options, this));

    database.on("ready", async () => {
      // TODO: get the latest block from the database
      // if we have a latest block, `root` will be that block's header.stateRoot
      // and we will skip creating the genesis block alltogether
      const root: Buffer = null;
      this.trie = new CheckpointTrie(database.trie, root);
      this.blocks = new BlockManager(this, database.blocks);
      this.vm = this.createVmFromStateTrie(this.trie, options.hardfork, options.allowUnlimitedContractSize);

      const gasLimit = options.gasLimit;
      const instamine = !options.blockTime || options.blockTime <= 0;
      const miner = new Miner(this.vm, {instamine, gasLimit});

      this.transactions = new TransactionManager(this, database.transactions, options);
      this.transactionReceipts = new Manager<TransactionReceipt>(
        this,
        database.transactionReceipts,
        TransactionReceipt
      );
      this.accounts = new AccountManager(this, database.trie);
      this.coinbase = options.coinbase.address;

      await this.#commitAccounts(options.initialAccounts);

      let firstBlockTime: number;
      if (options.time != null) {
        firstBlockTime = +options.time
        this.setTime(firstBlockTime);
      } else {
        firstBlockTime = this.#currentTime();
      }
      let lastBlock = this.#initializeGenesisBlock(firstBlockTime, gasLimit);

      const readyNextBlock = async (timestamp?: number) => {
        await lastBlock;
        const previousBlock = this.blocks.latest;
        const previousHeader = previousBlock.value.header;
        const previousNumber = Quantity.from(previousHeader.number).toBigInt() || 0n;
        return this.blocks.createBlock({
          number: Quantity.from(previousNumber + 1n).toBuffer(),
          gasLimit: gasLimit.toBuffer(),
          timestamp: timestamp || this.#currentTime(),
          parentHash: previousHeader.hash()
        });
      };

      if (instamine) {
        this.transactions.transactionPool.on("drain", async ({executables, timestamp, maxTransactions}: {maxTransactions: number ,executables: Map<string, utils.Heap<Transaction>>, timestamp?: number}) => {
          if (maxTransactions !== 0 && this.#isPaused()) return;
          const block = await readyNextBlock(timestamp);
          return miner.mine(executables, block.value, maxTransactions == null ? 1 : 0);
        });
      } else {
        const minerInterval = options.blockTime * 1000;
        const mine = (pending: Map<string, utils.Heap<Transaction>>) => {
          let promise: Promise<unknown>;
          if (!this.#isPaused()) {
            promise = readyNextBlock().then(block => {
              miner.mine(pending, block.value);
            });
          } else {
            promise = this.once("resume");
          }
          promise.then(() => utils.unref(setTimeout(mine, minerInterval, pending)));
          return void 0;
        };
        utils.unref(setTimeout(mine, minerInterval, this.transactions.transactionPool.executables));
      }

      miner.on("block", async (blockData: any) => {
        await lastBlock;
        const previousBlock = this.blocks.latest;
        const previousHeader = previousBlock.value.header;
        const previousNumber = Quantity.from(previousHeader.number).toBigInt() || 0n;
        const block = this.blocks.createBlock({
          parentHash: previousHeader.hash(),
          number: Quantity.from(previousNumber + 1n).toBuffer(),
          coinbase: this.coinbase.toBuffer(),
          timestamp: this.#currentTime(),
          // difficulty:
          gasLimit: options.gasLimit.toBuffer(),
          transactionsTrie: blockData.transactionsTrie.root,
          receiptTrie: blockData.receiptTrie.root,
          stateRoot: this.trie.root,
          gasUsed: Quantity.from(blockData.gasUsed).toBuffer()
        });

        this.blocks.latest = block;
        lastBlock = this.#database.batch(() => {
          blockData.blockTransactions.forEach((tx: Transaction, i: number) => {
            const hash = tx.hash();
            // todo: clean up transction extra data stuffs because this is gross:
            const extraData = [...tx.raw, block.value.hash(), block.value.header.number, Quantity.from(i).toBuffer()];
            const encodedTx = rlpEncode(extraData);
            this.transactions.set(hash, encodedTx);

            const receipt = tx.getReceipt();
            const encodedReceipt = receipt.serialize(true);
            this.transactionReceipts.set(hash, encodedReceipt);
          });
          block.value.transactions = blockData.blockTransactions;
          this.blocks.putBlock(block);
          return block;
        });

        lastBlock.then(block => {
          this.blocks.latest = block;
          // emit the block once everything has been fully saved to the database
          this.emit("block", block);
        });
      });

      this.blocks.earliest = this.blocks.latest = await lastBlock;
      this.#state = Status.started;
      this.emit("start");
    });
  }

  coinbase: Address;

  isMining = () => {
    return this.#state === Status.started;
  }

  #isPaused = () => {
    return (this.#state & Status.paused) !== 0;
  }

  pause() {
    this.#state |= Status.paused;
    this.emit("pause");
  }

  resume(threads: number = 1) {
    if (!this.#isPaused()) {
      console.log("Warning: startMining called when miner was already started");
      return;
    }
    // toggles the `paused` bit
    this.#state ^= Status.paused;
    this.emit("resume");
  }

  createVmFromStateTrie = (stateTrie: CheckpointTrie, hardfork: string, allowUnlimitedContractSize: boolean): any => {
    const common = Common.forCustomChain(
      "mainnet", // TODO needs to match chain id
      {
        name: "ganache",
        networkId: 1,
        chainId: 1,
        comment: "Local test network",
        bootstrapNodes: []
      },
      hardfork
    );
    const vm = new VM({
      state: stateTrie,
      activatePrecompiles: true,
      common,
      allowUnlimitedContractSize,
      blockchain: {
        getBlock: (number: BN, done: any) => {
          this.blocks.get(number.toBuffer()).then((block) => done(block.value));
        }
      } as any
    });
    vm.on("step", this.emit.bind(this, "step"));
    return vm;
  };

  #commitAccounts = async (accounts: Account[]): Promise<void> => {
    const stateManager = this.vm.stateManager;
    const putAccount = promisify(stateManager.putAccount.bind(stateManager));
    const checkpoint = promisify(stateManager.checkpoint.bind(stateManager));
    const commit = promisify(stateManager.commit.bind(stateManager));
    await checkpoint();
    const l = accounts.length;
    const pendingAccounts = Array(l);
    for (let i = 0; i < l; i++) {
      const account = accounts[i];
      const ethereumJsAccount = new EthereumJsAccount();
      (ethereumJsAccount.nonce = account.nonce.toBuffer()), (ethereumJsAccount.balance = account.balance.toBuffer());
      pendingAccounts[i] = putAccount(account.address.toBuffer(), ethereumJsAccount);
    }
    await Promise.all(pendingAccounts);
    await commit();
  };

  #initializeGenesisBlock = async (timestamp: number, blockGasLimit: Quantity): Promise<Block> => {
    // create the genesis block
    const genesis = this.blocks.next({
      // If we were given a timestamp, use it instead of the `_currentTime`
      timestamp,
      gasLimit: blockGasLimit.toBuffer(),
      stateRoot: this.trie.root,
      number: "0x0"
    });

    // store the genesis block in the database
    return this.blocks.putBlock(genesis);
  };

  #timeAdjustment: number = 0;

  #currentTime = () => {
    return Math.floor(Date.now() / 1000) + this.#timeAdjustment;
  };

  public increaseTime(seconds: number) {
    if (seconds < 0) {
      seconds = 0;
    }
    return this.#timeAdjustment += seconds;
  }
  
  public setTime(timestamp: number) {
    return this.#timeAdjustment = Math.floor((timestamp - Date.now()) / 1000);
  }

  // TODO: this.#snapshots is a potential unbound memory suck. Caller could call `evm_snapshot` over and over
  // to grow the snapshot stack indefinitely
  #snapshots: any[] = [];
  public snapshot() {
    const currentBlockHeader = this.blocks.latest.value.header;
    const hash = currentBlockHeader.hash();
    const stateRoot = currentBlockHeader.stateRoot;

    // TODO: logger.log...
    // self.logger.log("Saved snapshot #" + self.snapshots.length);
    
    return this.#snapshots.push({
      hash,
      stateRoot,
      timeAdjustment: this.#timeAdjustment
    });
  }

  #deleteBlockData = (block: Block) => {
    const blocks = this.blocks;
    return this.#database.batch(() => {
      blocks.del(block.value.header.number);
      blocks.del(block.value.header.hash());
      block.value.transactions.forEach(tx => {
        const txHash = tx.hash();
        this.transactions.del(txHash);
        this.transactionReceipts.del(txHash);
      });
    });
  }
  public async revert(snapshotId: Quantity) {

    const rawValue = snapshotId.valueOf();
    if (rawValue === null || rawValue === undefined) {
      throw new Error("invalid snapshotId");
    }

    // TODO: logger.log...
    // this.logger.log("Reverting to snapshot #" + snapshotId);

    const snapshotNumber = rawValue - 1n;
    if (snapshotNumber < 0n) {
      return false;
    }

    const snapshotsToRemove = this.#snapshots.splice(Number(snapshotNumber));
    const snapshot = snapshotsToRemove.shift();

    if (!snapshot) {
      return false;
    }

    const blocks = this.blocks;
    const currentBlock = blocks.latest;
    const currentHash = currentBlock.value.header.hash();
    const snapshotHash = snapshot.hash;

    // if nothing was added since we snapshotted just return immediately.
    if (currentHash.equals(snapshotHash)) {
      return true;
    } else {
      const stateManager = this.vm.stateManager;
      // TODO: we may need to ensure nothing can be written to the blockchain
      // whilst setting the state root, otherwise we could get into weird states.
      // Additionally, if something has created a vm checkpoint `setStateRoot`
      // will fail anyway.
      const settingStateRootProm = promisify(stateManager.setStateRoot.bind(stateManager))(
        snapshot.stateRoot
      );
      const getBlockProm = this.blocks.getByHash(snapshotHash);

      // TODO: lazily clean up the database. Get all blocks created since our reverted
      // snapshot was created, and delete them, and their transaction data.
      // TODO: look into optimizing this to delete from all reverted snapshots.
      //   the current approach looks at each block, finds its parent, then
      //   finds its parent, and so on until we reach our target block. Whenever
      //   we revert a snapshot, we may also throwing away several others, and
      //   there may be an optimization here by querying for those other
      //   snapshots' blocks simultaneously.
      let nextBlock = currentBlock;
      const promises = [getBlockProm, settingStateRootProm] as [Promise<Block>, ...Promise<unknown>[]];
      do {
        promises.push(this.#deleteBlockData(nextBlock));
        const header = nextBlock.value.header
        if (header.parentHash.equals(snapshotHash)) {
          break;
        } else {
          nextBlock = await blocks.get(header.number);
        }
      } while(nextBlock);

      const [latest] = await Promise.all(promises);
      this.blocks.latest = latest as Block;
      // put our time back!
      this.#timeAdjustment = snapshot.timeAdjustment;
      // update our cached "latest" block
      return true;
    }
  }

  public async queueTransaction(transaction: any, secretKey?: Data): Promise<Data> {
    await this.transactions.push(transaction, secretKey);
    return Data.from(transaction.hash());
  }

  public async simulateTransaction(transaction: any, parentBlock: Block, block: Block): Promise<Data> {
    // TODO: this is just a prototype implementation
    const vm = this.vm.copy();
    const stateManager = vm.stateManager;
    const settingStateRootProm = promisify(stateManager.setStateRoot.bind(stateManager))(
      parentBlock.value.header.stateRoot
    );
    transaction.block = block.value;
    transaction.caller = transaction.from || block.value.header.coinbase;
    await settingStateRootProm;
    const result = await vm.runCall(transaction);
    return Data.from(result.execResult.returnValue || "0x");
  }

  /**
   * Gracefully shuts down the blockchain service and all of its dependencies.
   */
  public async stop() {
    // If the blockchain is still initalizing we don't want to shut down
    // yet because there may still be database calls in flight. Leveldb may
    // cause a segfault due to a race condition between a db write and the close
    // call.
    if (this.#state === Status.starting) {
      await new Promise(resolve => {
        this.on("start", resolve);
      });
    }
    if (this.#state === Status.started) {
      this.#state = Status.stopping;
      await this.#database.close();
      this.#state = Status.stopped;
    }
    this.emit("stop");
  }
}