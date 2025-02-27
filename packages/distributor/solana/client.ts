import BN from "bn.js";
import PQueue from "p-queue";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, createTransferCheckedInstruction } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Commitment,
  ConnectionConfig,
} from "@solana/web3.js";
import { ICluster, ITransactionResult } from "@streamflow/common";
import {
  ata,
  checkOrCreateAtaBatch,
  prepareWrappedAccount,
  prepareBaseInstructions,
  prepareTransaction,
  getMintAndProgram,
  buildSendThrottler,
} from "@streamflow/common/solana";

import { DISTRIBUTOR_PROGRAM_ID } from "./constants";
import {
  IClaimData,
  IClawbackData,
  ICreateDistributorData,
  ICreateDistributorResult,
  IGetClaimData,
  IGetDistributors,
  ICreateSolanaExt,
  IInteractSolanaExt,
} from "./types";
import {
  ClaimLockedAccounts,
  ClawbackAccounts,
  NewClaimAccounts,
  NewClaimArgs,
  NewDistributorAccounts,
  NewDistributorArgs,
  claimLocked,
  clawback,
  newClaim,
  newDistributor,
} from "./generated/instructions";
import { ClaimStatus, MerkleDistributor } from "./generated/accounts";
import {
  getClaimantStatusPda,
  getDistributorPda,
  getEventAuthorityPda,
  wrappedSignAndExecuteTransaction,
} from "./utils";

interface IInitOptions {
  clusterUrl: string;
  cluster?: ICluster;
  commitment?: Commitment | ConnectionConfig;
  programId?: string;
  sendRate?: number;
  sendThrottler?: PQueue;
}

export default class SolanaDistributorClient {
  private connection: Connection;

  private programId: PublicKey;

  private commitment: Commitment | ConnectionConfig;

  private sendThrottler: PQueue;

  /**
   * Create Stream instance
   */
  constructor({
    clusterUrl,
    cluster = ICluster.Mainnet,
    commitment = "confirmed",
    programId = "",
    sendRate = 1,
    sendThrottler,
  }: IInitOptions) {
    this.commitment = commitment;
    this.connection = new Connection(clusterUrl, this.commitment);
    this.programId = programId !== "" ? new PublicKey(programId) : new PublicKey(DISTRIBUTOR_PROGRAM_ID[cluster]);
    this.sendThrottler = sendThrottler ?? buildSendThrottler(sendRate);
  }

  public getCommitment(): Commitment | undefined {
    return typeof this.commitment == "string" ? this.commitment : this.commitment.commitment;
  }

  public async create(data: ICreateDistributorData, extParams: ICreateSolanaExt): Promise<ICreateDistributorResult> {
    const { ixs, distributorPublicKey } = await this.prepareCreateInstructions(data, extParams);
    const { tx, hash, context } = await prepareTransaction(this.connection, ixs, extParams.invoker.publicKey);
    const signature = await wrappedSignAndExecuteTransaction(
      this.connection,
      extParams.invoker,
      tx,
      {
        hash,
        context,
        commitment: this.getCommitment(),
      },
      { sendThrottler: this.sendThrottler },
    );

    return {
      ixs,
      txId: signature,
      metadataId: distributorPublicKey.toBase58(),
    };
  }

  public async prepareCreateInstructions(
    data: ICreateDistributorData,
    extParams: ICreateSolanaExt,
  ): Promise<{ distributorPublicKey: PublicKey; ixs: TransactionInstruction[] }> {
    if (!extParams.invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const ixs: TransactionInstruction[] = prepareBaseInstructions(this.connection, extParams);
    const mint = extParams.isNative ? NATIVE_MINT : new PublicKey(data.mint);
    const { mint: mintAccount, tokenProgramId } = await getMintAndProgram(this.connection, mint);
    const distributorPublicKey = getDistributorPda(this.programId, mint, data.version);
    const tokenVault = await ata(mint, distributorPublicKey, tokenProgramId);
    const senderTokens = await ata(mint, extParams.invoker.publicKey, tokenProgramId);

    const args: NewDistributorArgs = {
      version: new BN(data.version, 10),
      root: data.root,
      maxTotalClaim: data.maxTotalClaim,
      maxNumNodes: data.maxNumNodes,
      unlockPeriod: new BN(data.unlockPeriod, 10),
      startVestingTs: new BN(data.startVestingTs, 10),
      endVestingTs: new BN(data.endVestingTs, 10),
      clawbackStartTs: new BN(data.clawbackStartTs, 10),
      claimsClosable: data.claimsClosable,
    };
    const accounts: NewDistributorAccounts = {
      distributor: distributorPublicKey,
      clawbackReceiver: senderTokens,
      mint,
      tokenVault,
      admin: extParams.invoker.publicKey,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: tokenProgramId,
    };

    if (extParams.isNative) {
      ixs.push(...(await prepareWrappedAccount(this.connection, extParams.invoker.publicKey, data.maxTotalClaim)));
    }

    const nowTs = new BN(Math.floor(Date.now() / 1000));
    const endVestingTs = args.endVestingTs.eqn(0) ? nowTs : args.endVestingTs;
    const startVestingTs = args.startVestingTs.eqn(0) ? nowTs : args.startVestingTs;
    if (endVestingTs.gt(startVestingTs) && endVestingTs.sub(startVestingTs).lt(args.unlockPeriod)) {
      throw new Error("The unlock period cannot be longer than the total vesting duration!");
    }

    ixs.push(newDistributor(args, accounts, this.programId));
    ixs.push(
      createTransferCheckedInstruction(
        senderTokens,
        mint,
        tokenVault,
        extParams.invoker.publicKey,
        BigInt(data.maxTotalClaim.toString()),
        mintAccount.decimals,
        undefined,
        tokenProgramId,
      ),
    );

    return { distributorPublicKey, ixs };
  }

  public async claim(data: IClaimData, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const ixs = await this.prepareClaimInstructions(data, extParams);
    const { tx, hash, context } = await prepareTransaction(this.connection, ixs, extParams.invoker.publicKey);
    const signature = await wrappedSignAndExecuteTransaction(
      this.connection,
      extParams.invoker,
      tx,
      {
        hash,
        context,
        commitment: this.getCommitment(),
      },
      { sendThrottler: this.sendThrottler },
    );

    return { ixs, txId: signature };
  }

  public async prepareClaimInstructions(
    data: IClaimData,
    extParams: IInteractSolanaExt,
  ): Promise<TransactionInstruction[]> {
    if (!extParams.invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const distributorPublicKey = new PublicKey(data.id);
    const distributor = await MerkleDistributor.fetch(this.connection, distributorPublicKey);

    if (!distributor) {
      throw new Error("Couldn't get account info");
    }

    const { tokenProgramId } = await getMintAndProgram(this.connection, distributor.mint);
    const ixs: TransactionInstruction[] = prepareBaseInstructions(this.connection, extParams);
    ixs.push(
      ...(await checkOrCreateAtaBatch(
        this.connection,
        [extParams.invoker.publicKey],
        distributor.mint,
        extParams.invoker,
        tokenProgramId,
      )),
    );
    const invokerTokens = await ata(distributor.mint, extParams.invoker.publicKey, tokenProgramId);
    const claimStatusPublicKey = getClaimantStatusPda(
      this.programId,
      distributorPublicKey,
      extParams.invoker.publicKey,
    );
    const eventAuthorityPublicKey = getEventAuthorityPda(this.programId);
    const claimStatus = await ClaimStatus.fetch(this.connection, claimStatusPublicKey);

    const accounts: ClaimLockedAccounts | NewClaimAccounts = {
      distributor: distributorPublicKey,
      claimStatus: claimStatusPublicKey,
      from: distributor.tokenVault,
      to: invokerTokens,
      claimant: extParams.invoker.publicKey,
      mint: distributor.mint,
      tokenProgram: tokenProgramId,
      systemProgram: SystemProgram.programId,
      eventAuthority: eventAuthorityPublicKey,
      program: this.programId,
    };

    if (!claimStatus) {
      const args: NewClaimArgs = {
        amountLocked: data.amountLocked,
        amountUnlocked: data.amountUnlocked,
        proof: data.proof,
      };
      ixs.push(newClaim(args, accounts, this.programId));
    }

    const nowTs = new BN(Math.floor(Date.now() / 1000));
    if (claimStatus || (data.amountLocked.gtn(0) && nowTs.sub(distributor.startTs).gte(distributor.unlockPeriod))) {
      ixs.push(claimLocked(accounts, this.programId));
    }

    return ixs;
  }

  public async clawback(data: IClawbackData, extParams: IInteractSolanaExt): Promise<ITransactionResult> {
    const ixs = await this.prepareClawbackInstructions(data, extParams);
    const { tx, hash, context } = await prepareTransaction(this.connection, ixs, extParams.invoker.publicKey);
    const signature = await wrappedSignAndExecuteTransaction(
      this.connection,
      extParams.invoker,
      tx,
      {
        hash,
        context,
        commitment: this.getCommitment(),
      },
      { sendThrottler: this.sendThrottler },
    );

    return { ixs, txId: signature };
  }

  public async prepareClawbackInstructions(
    data: IClawbackData,
    extParams: IInteractSolanaExt,
  ): Promise<TransactionInstruction[]> {
    if (!extParams.invoker.publicKey) {
      throw new Error("Invoker's PublicKey is not available, check passed wallet adapter!");
    }

    const distributorPublicKey = new PublicKey(data.id);
    const distributor = await MerkleDistributor.fetch(this.connection, distributorPublicKey);

    if (!distributor) {
      throw new Error("Couldn't get account info");
    }

    const { tokenProgramId } = await getMintAndProgram(this.connection, distributor.mint);
    const ixs: TransactionInstruction[] = prepareBaseInstructions(this.connection, extParams);
    ixs.push(
      ...(await checkOrCreateAtaBatch(
        this.connection,
        [extParams.invoker.publicKey],
        distributor.mint,
        extParams.invoker,
        tokenProgramId,
      )),
    );
    const accounts: ClawbackAccounts = {
      distributor: distributorPublicKey,
      from: distributor.tokenVault,
      to: distributor.clawbackReceiver,
      admin: extParams.invoker.publicKey,
      mint: distributor.mint,
      systemProgram: SystemProgram.programId,
      tokenProgram: tokenProgramId,
    };

    ixs.push(clawback(accounts, this.programId));

    return ixs;
  }

  public async getClaims(data: IGetClaimData[]): Promise<(ClaimStatus | null)[]> {
    const claimStatusPublicKeys = data.map(({ id, recipient }) => {
      return getClaimantStatusPda(this.programId, new PublicKey(id), new PublicKey(recipient));
    });
    return ClaimStatus.fetchMultiple(this.connection, claimStatusPublicKeys, this.programId);
  }

  public async getDistributors(data: IGetDistributors): Promise<(MerkleDistributor | null)[]> {
    const distributorPublicKeys = data.ids.map((distributorId) => new PublicKey(distributorId));
    return MerkleDistributor.fetchMultiple(this.connection, distributorPublicKeys, this.programId);
  }
}
