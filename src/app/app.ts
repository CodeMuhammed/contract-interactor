import { afterNextRender, Component, OnDestroy, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type {
  EventMap,
  NearConnector as NearConnectorInstance,
  NearWalletBase,
} from '@hot-labs/near-connect';

const FACTORY_ACCOUNT_ID = 'nzaza.testnet';
const TESTNET_RPC_URL = 'https://rpc.testnet.fastnear.com';
const FACTORY_CALL_GAS = '300000000000000';
const YOCTO_PER_NEAR = 10n ** 24n;

interface FactoryContractState {
  owner: string;
  vault_minting_fee: string;
  vault_counter: number;
}

type JsonAmount = string | number;

interface LiquidityRequestDetails {
  token: string;
  amount: JsonAmount;
  interest: JsonAmount;
  collateral: JsonAmount;
  duration: number;
  created_at: JsonAmount;
}

interface AcceptedOfferDetails {
  lender: string;
  accepted_at: JsonAmount;
}

interface UnstakeEntryDetails {
  amount: JsonAmount;
  epoch_height: number;
}

interface LiquidationDetails {
  liquidated: JsonAmount;
}

interface CounterOfferDetails {
  proposer: string;
  amount: JsonAmount;
  timestamp: JsonAmount;
}

interface RefundEntryDetails {
  token: string | null;
  proposer: string;
  amount: JsonAmount;
  added_at_epoch: number;
}

interface VaultContractState {
  owner: string;
  index: number;
  version: number;
  liquidity_request: LiquidityRequestDetails | null;
  accepted_offer: AcceptedOfferDetails | null;
  is_listed_for_takeover: boolean;
  active_validators: string[];
  unstake_entries: Array<[string, UnstakeEntryDetails]>;
  liquidation: LiquidationDetails | null;
  current_epoch: number;
}

interface UserVaultSummary {
  accountId: string;
  index: number;
  version: number;
  activeValidators: string[];
  hasLiquidityRequest: boolean;
  hasAcceptedOffer: boolean;
  isListedForTakeover: boolean;
  currentEpoch: number;
}

interface VaultFullDetails {
  state: VaultContractState;
  accountBalance: string;
  lockedBalance: string;
  availableBalance: string;
  storageCost: string;
  storageUsage: number;
  codeHash: string;
  blockHeight: number;
  counterOffers: Array<{ accountId: string; offer: CounterOfferDetails }>;
  refundEntries: Array<{ id: number; entry: RefundEntryDetails }>;
}

interface NearRpcResponse {
  result?: {
    result?: number[];
    amount?: string;
    locked?: string;
    storage_usage?: number;
    code_hash?: string;
    block_height?: number;
    block_hash?: string;
  };
  error?: { message?: string };
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  protected readonly accountId = signal<string | null>(null);
  protected readonly walletName = signal<string | null>(null);
  protected readonly isInitializing = signal(true);
  protected readonly isReady = signal(false);
  protected readonly isBusy = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly isLoadingFactoryState = signal(true);
  protected readonly mintingFeeDisplay = signal<string | null>(null);
  protected readonly mintedVaultCount = signal<number | null>(null);
  protected readonly factoryErrorMessage = signal('');
  protected readonly isCreatingVault = signal(false);
  protected readonly vaultErrorMessage = signal('');
  protected readonly vaultSuccessMessage = signal('');
  protected readonly vaultTransactionHash = signal<string | null>(null);
  protected readonly userVaults = signal<UserVaultSummary[]>([]);
  protected readonly isLoadingUserVaults = signal(false);
  protected readonly vaultScanProgress = signal(0);
  protected readonly vaultScanTotal = signal(0);
  protected readonly userVaultsErrorMessage = signal('');
  protected readonly selectedVaultAccountId = signal<string | null>(null);
  protected readonly selectedVaultDetails = signal<VaultFullDetails | null>(null);
  protected readonly isLoadingVaultDetails = signal(false);
  protected readonly vaultDetailsErrorMessage = signal('');

  private connector: NearConnectorInstance | null = null;
  private destroyed = false;
  private vaultScanRequestId = 0;
  private vaultDetailsRequestId = 0;

  constructor() {
    afterNextRender(() => {
      void this.initializeNearWallet();
      void this.refreshFactoryState();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.removeConnectorListeners();
  }

  protected async connectNearWallet(): Promise<void> {
    const connector = this.connector;
    if (!connector || this.isBusy()) return;

    this.isBusy.set(true);
    this.errorMessage.set('');

    try {
      await connector.whenManifestLoaded;
      const wallet = await connector.connect();
      const accounts = await wallet.getAccounts();
      this.setConnectedWallet(wallet, accounts[0]?.accountId ?? null);
    } catch {
      this.errorMessage.set(
        'The connection was cancelled or could not be completed. Please try again.',
      );
    } finally {
      this.isBusy.set(false);
    }
  }

  protected async disconnectNearWallet(): Promise<void> {
    const connector = this.connector;
    if (!connector || this.isBusy()) return;

    this.isBusy.set(true);
    this.errorMessage.set('');

    try {
      await connector.disconnect();
      this.clearConnectedWallet();
    } catch {
      this.errorMessage.set('Could not disconnect the NEAR wallet. Please try again.');
    } finally {
      this.isBusy.set(false);
    }
  }

  protected async refreshFactoryState(): Promise<void> {
    this.isLoadingFactoryState.set(true);
    this.factoryErrorMessage.set('');

    try {
      this.applyFactoryState(await this.fetchFactoryState());
    } catch {
      this.mintingFeeDisplay.set(null);
      this.mintedVaultCount.set(null);
      this.factoryErrorMessage.set(
        'Could not load the factory details from NEAR testnet. Try again.',
      );
    } finally {
      this.isLoadingFactoryState.set(false);
    }
  }

  protected async createVault(): Promise<void> {
    const connector = this.connector;
    if (!connector || !this.accountId() || this.isCreatingVault()) return;

    this.isCreatingVault.set(true);
    this.vaultErrorMessage.set('');
    this.vaultSuccessMessage.set('');
    this.vaultTransactionHash.set(null);

    try {
      const factoryState = await this.fetchFactoryState();
      this.applyFactoryState(factoryState);

      const { wallet, accounts } = await connector.getConnectedWallet();
      if (!accounts.some((account) => account.accountId === this.accountId())) {
        throw new Error('Reconnect your NEAR wallet before creating a vault.');
      }

      const outcome = await wallet.signAndSendTransaction({
        receiverId: FACTORY_ACCOUNT_ID,
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'mint_vault',
              args: {},
              gas: FACTORY_CALL_GAS,
              deposit: factoryState.vault_minting_fee,
            },
          },
        ],
      });

      if (this.isFailedOutcome(outcome)) {
        throw new Error('The factory rejected the vault creation transaction.');
      }

      const transactionHash = outcome.transaction.hash;
      const vaultId = this.findMintedVaultId(outcome);
      this.vaultTransactionHash.set(transactionHash);
      this.vaultSuccessMessage.set(
        vaultId ? `Vault created: ${vaultId}` : 'Vault creation transaction confirmed.',
      );
      void this.refreshFactoryState();
      void this.refreshUserVaults();
    } catch (error) {
      this.vaultErrorMessage.set(
        error instanceof Error
          ? error.message
          : 'Could not create the vault. Please try again.',
      );
    } finally {
      this.isCreatingVault.set(false);
    }
  }

  protected async refreshUserVaults(): Promise<void> {
    const connectedAccountId = this.accountId();
    if (!connectedAccountId) return;

    const requestId = ++this.vaultScanRequestId;
    this.isLoadingUserVaults.set(true);
    this.userVaultsErrorMessage.set('');
    this.userVaults.set([]);
    this.clearSelectedVaultDetails();
    this.vaultScanProgress.set(0);
    this.vaultScanTotal.set(0);

    try {
      const factoryState = await this.fetchFactoryState();
      if (!this.isCurrentVaultScan(requestId, connectedAccountId)) return;

      this.applyFactoryState(factoryState);
      this.vaultScanTotal.set(factoryState.vault_counter);

      const matches: UserVaultSummary[] = [];
      let nextIndex = 0;
      let completed = 0;
      let unreadable = 0;
      const workerCount = Math.min(8, factoryState.vault_counter);
      const workers = Array.from({ length: workerCount }, async () => {
        while (
          nextIndex < factoryState.vault_counter &&
          this.isCurrentVaultScan(requestId, connectedAccountId)
        ) {
          const index = nextIndex++;
          const vaultAccountId = `vault-${index}.${FACTORY_ACCOUNT_ID}`;

          try {
            const state = await this.fetchVaultState(vaultAccountId);
            if (state.owner === connectedAccountId) {
              matches.push({
                accountId: vaultAccountId,
                index: state.index,
                version: state.version,
                activeValidators: state.active_validators,
                hasLiquidityRequest:
                  state.liquidity_request !== null && state.liquidity_request !== undefined,
                hasAcceptedOffer:
                  state.accepted_offer !== null && state.accepted_offer !== undefined,
                isListedForTakeover: state.is_listed_for_takeover,
                currentEpoch: state.current_epoch,
              });
            }
          } catch {
            unreadable += 1;
          } finally {
            completed += 1;
            if (this.isCurrentVaultScan(requestId, connectedAccountId)) {
              this.vaultScanProgress.set(completed);
            }
          }
        }
      });

      await Promise.all(workers);
      if (!this.isCurrentVaultScan(requestId, connectedAccountId)) return;

      this.userVaults.set(matches.sort((a, b) => b.index - a.index));
      if (unreadable > 0) {
        this.userVaultsErrorMessage.set(
          `Could not read ${unreadable} of ${factoryState.vault_counter} factory vaults. The list may be incomplete; retry to refresh it.`,
        );
      }
    } catch {
      if (this.isCurrentVaultScan(requestId, connectedAccountId)) {
        this.userVaultsErrorMessage.set(
          'Could not load vaults from NEAR testnet. Try again.',
        );
      }
    } finally {
      if (requestId === this.vaultScanRequestId) {
        this.isLoadingUserVaults.set(false);
      }
    }
  }

  protected async toggleVaultDetails(vault: UserVaultSummary): Promise<void> {
    if (
      this.selectedVaultAccountId() === vault.accountId &&
      !this.vaultDetailsErrorMessage()
    ) {
      this.clearSelectedVaultDetails();
      return;
    }

    const requestId = ++this.vaultDetailsRequestId;
    this.selectedVaultAccountId.set(vault.accountId);
    this.selectedVaultDetails.set(null);
    this.vaultDetailsErrorMessage.set('');
    this.isLoadingVaultDetails.set(true);

    try {
      const [state, account, availableBalance, storageCost, counterOffers, refundEntries] =
        await Promise.all([
          this.fetchVaultState(vault.accountId),
          this.fetchVaultAccountView(vault.accountId),
          this.fetchContractView<JsonAmount>(vault.accountId, 'view_available_balance'),
          this.fetchContractView<JsonAmount>(vault.accountId, 'view_storage_cost'),
          this.fetchContractView<Record<string, CounterOfferDetails> | null>(
            vault.accountId,
            'get_counter_offers',
          ),
          this.fetchContractView<Array<[number, RefundEntryDetails]>>(
            vault.accountId,
            'get_refund_entries',
            'eyJhY2NvdW50X2lkIjpudWxsfQ==',
          ),
        ]);

      if (requestId !== this.vaultDetailsRequestId) return;
      if (
        !account.amount ||
        !account.locked ||
        typeof account.storage_usage !== 'number' ||
        typeof account.code_hash !== 'string' ||
        typeof account.block_height !== 'number'
      ) {
        throw new Error('The NEAR account returned incomplete details.');
      }

      this.selectedVaultDetails.set({
        state,
        accountBalance: account.amount,
        lockedBalance: account.locked,
        availableBalance: String(availableBalance),
        storageCost: String(storageCost),
        storageUsage: account.storage_usage,
        codeHash: account.code_hash,
        blockHeight: account.block_height,
        counterOffers: Object.entries(counterOffers ?? {}).map(([accountId, offer]) => ({
          accountId,
          offer,
        })),
        refundEntries: refundEntries.map(([id, entry]) => ({ id, entry })),
      });
    } catch {
      if (requestId === this.vaultDetailsRequestId) {
        this.vaultDetailsErrorMessage.set(
          'Could not load the full vault details from NEAR testnet. Try again.',
        );
      }
    } finally {
      if (requestId === this.vaultDetailsRequestId) {
        this.isLoadingVaultDetails.set(false);
      }
    }
  }

  private async initializeNearWallet(): Promise<void> {
    try {
      const { NearConnector } = await import('@hot-labs/near-connect');
      if (this.destroyed) return;

      const connector = new NearConnector({ network: 'testnet' });
      this.connector = connector;
      connector.on('wallet:signIn', this.handleWalletSignIn);
      connector.on('wallet:signOut', this.handleWalletSignOut);

      await connector.whenManifestLoaded;
      if (this.destroyed) return;
      this.isReady.set(true);

      try {
        const { wallet, accounts } = await connector.getConnectedWallet();
        this.setConnectedWallet(wallet, accounts[0]?.accountId ?? null);
      } catch {
        this.clearConnectedWallet();
      }
    } catch {
      this.errorMessage.set('Could not load NEAR wallet options. Refresh and try again.');
    } finally {
      if (!this.destroyed) this.isInitializing.set(false);
    }
  }

  private async fetchFactoryState(): Promise<FactoryContractState> {
    const state = await this.fetchContractView<Partial<FactoryContractState>>(
      FACTORY_ACCOUNT_ID,
      'get_contract_state',
    );
    if (
      typeof state.owner !== 'string' ||
      typeof state.vault_minting_fee !== 'string' ||
      !/^\d+$/.test(state.vault_minting_fee) ||
      typeof state.vault_counter !== 'number' ||
      !Number.isSafeInteger(state.vault_counter) ||
      state.vault_counter < 0
    ) {
      throw new Error('The factory returned an invalid state.');
    }

    return state as FactoryContractState;
  }

  private async fetchVaultState(accountId: string): Promise<VaultContractState> {
    const state = await this.fetchContractView<Partial<VaultContractState>>(
      accountId,
      'get_vault_state',
    );
    if (
      typeof state.owner !== 'string' ||
      typeof state.index !== 'number' ||
      !Number.isSafeInteger(state.index) ||
      typeof state.version !== 'number' ||
      !Number.isSafeInteger(state.version) ||
      typeof state.is_listed_for_takeover !== 'boolean' ||
      !Array.isArray(state.active_validators) ||
      !state.active_validators.every((validator) => typeof validator === 'string') ||
      !Array.isArray(state.unstake_entries) ||
      typeof state.current_epoch !== 'number' ||
      !Number.isSafeInteger(state.current_epoch)
    ) {
      throw new Error('A vault returned invalid state.');
    }

    return state as VaultContractState;
  }

  private async fetchContractView<T>(
    accountId: string,
    methodName: string,
    argsBase64 = 'e30=',
  ): Promise<T> {
    const rpcResponse = await this.requestNearRpc(`view-${accountId}-${methodName}`, {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: methodName,
      args_base64: argsBase64,
    });
    if (!rpcResponse.result?.result) {
      throw new Error(`${methodName} did not return a result.`);
    }

    const json = new TextDecoder().decode(Uint8Array.from(rpcResponse.result.result));
    return JSON.parse(json) as T;
  }

  private async fetchVaultAccountView(accountId: string): Promise<NonNullable<NearRpcResponse['result']>> {
    const rpcResponse = await this.requestNearRpc(`account-${accountId}`, {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (!rpcResponse.result) {
      throw new Error('The NEAR account did not return a result.');
    }

    return rpcResponse.result;
  }

  private async requestNearRpc(
    id: string,
    params: Record<string, string>,
  ): Promise<NearRpcResponse> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(TESTNET_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'query',
            params,
          }),
        });
      } catch (error) {
        if (attempt === 2) throw error;
        await this.waitForRpcRetry(attempt);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === 2) {
          throw new Error(`NEAR RPC is temporarily unavailable (HTTP ${response.status}).`);
        }
        await this.waitForRpcRetry(attempt);
        continue;
      }

      const rpcResponse = (await response.json()) as NearRpcResponse;
      if (!response.ok || rpcResponse.error) {
        throw new Error(rpcResponse.error?.message ?? `NEAR RPC returned HTTP ${response.status}.`);
      }

      return rpcResponse;
    }

    throw new Error('NEAR RPC is unavailable.');
  }

  private waitForRpcRetry(attempt: number): Promise<void> {
    const delayMs = 300 * 2 ** attempt;
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private isCurrentVaultScan(requestId: number, accountId: string): boolean {
    return requestId === this.vaultScanRequestId && this.accountId() === accountId;
  }

  private applyFactoryState(state: FactoryContractState): void {
    this.mintingFeeDisplay.set(this.formatYoctoNear(state.vault_minting_fee));
    this.mintedVaultCount.set(state.vault_counter);
  }

  protected formatYoctoNear(amount: JsonAmount): string {
    const value = BigInt(amount);
    const whole = value / YOCTO_PER_NEAR;
    const fraction = (value % YOCTO_PER_NEAR)
      .toString()
      .padStart(24, '0')
      .replace(/0+$/, '');
    return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''} NEAR`;
  }

  protected formatNanoseconds(value: JsonAmount): string {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    return Number.isFinite(milliseconds)
      ? new Date(milliseconds).toLocaleString()
      : String(value);
  }

  private isFailedOutcome(outcome: unknown): boolean {
    if (!outcome || typeof outcome !== 'object') return false;

    const result = outcome as { final_execution_status?: string; status?: unknown };
    if (result.final_execution_status === 'EXECUTED_FAILURE') return true;
    return (
      typeof result.status === 'object' &&
      result.status !== null &&
      'Failure' in result.status
    );
  }

  private findMintedVaultId(outcome: unknown): string | null {
    if (!outcome || typeof outcome !== 'object') return null;

    const result = outcome as {
      transaction_outcome?: { outcome?: { logs?: string[] } };
      receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
    };
    const logs = [
      ...(result.transaction_outcome?.outcome?.logs ?? []),
      ...(result.receipts_outcome ?? []).flatMap((receipt) => receipt.outcome?.logs ?? []),
    ];

    for (const log of logs) {
      const marker = log.indexOf('EVENT_JSON:');
      if (marker < 0) continue;

      try {
        const event = JSON.parse(log.slice(marker + 'EVENT_JSON:'.length)) as {
          event?: string;
          data?: { vault?: string };
        };
        if (event.event === 'vault_minted' && typeof event.data?.vault === 'string') {
          return event.data.vault;
        }
      } catch {
        // Ignore unrelated or malformed contract logs.
      }
    }

    return null;
  }

  private readonly handleWalletSignIn = (event: EventMap['wallet:signIn']): void => {
    if (!event.success) return;
    this.setConnectedWallet(event.wallet, event.accounts[0]?.accountId ?? null);
  };

  private readonly handleWalletSignOut = (): void => {
    this.clearConnectedWallet();
  };

  private setConnectedWallet(
    wallet: NearWalletBase,
    accountId: string | null,
  ): void {
    const accountChanged = this.accountId() !== accountId;
    this.walletName.set(wallet.manifest.name);
    this.accountId.set(accountId);
    this.errorMessage.set('');
    if (accountChanged) {
      if (accountId) {
        void this.refreshUserVaults();
      } else {
        this.clearUserVaults();
      }
    }
  }

  private clearConnectedWallet(): void {
    this.walletName.set(null);
    this.accountId.set(null);
    this.clearUserVaults();
  }

  private clearUserVaults(): void {
    this.vaultScanRequestId += 1;
    this.userVaults.set([]);
    this.isLoadingUserVaults.set(false);
    this.vaultScanProgress.set(0);
    this.vaultScanTotal.set(0);
    this.userVaultsErrorMessage.set('');
    this.clearSelectedVaultDetails();
  }

  private clearSelectedVaultDetails(): void {
    this.vaultDetailsRequestId += 1;
    this.selectedVaultAccountId.set(null);
    this.selectedVaultDetails.set(null);
    this.isLoadingVaultDetails.set(false);
    this.vaultDetailsErrorMessage.set('');
  }

  private removeConnectorListeners(): void {
    this.connector?.off('wallet:signIn', this.handleWalletSignIn);
    this.connector?.off('wallet:signOut', this.handleWalletSignOut);
    this.connector = null;
  }
}
