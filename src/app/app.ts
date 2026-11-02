import { afterNextRender, Component, OnDestroy, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type {
  EventMap,
  NearConnector as NearConnectorInstance,
  NearWalletBase,
} from '@hot-labs/near-connect';

const FACTORY_ACCOUNT_ID = 'nzaza.testnet';
const TESTNET_RPC_URL = 'https://rpc.testnet.near.org';
const FACTORY_CALL_GAS = '300000000000000';
const YOCTO_PER_NEAR = 10n ** 24n;

interface FactoryContractState {
  owner: string;
  vault_minting_fee: string;
  vault_counter: number;
}

interface NearRpcResponse {
  result?: { result?: number[] };
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

  private connector: NearConnectorInstance | null = null;
  private destroyed = false;

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
    const response = await fetch(TESTNET_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'contract-interactor-factory-state',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: FACTORY_ACCOUNT_ID,
          method_name: 'get_contract_state',
          args_base64: 'e30=',
        },
      }),
    });

    const rpcResponse = (await response.json()) as NearRpcResponse;
    if (!response.ok || rpcResponse.error || !rpcResponse.result?.result) {
      throw new Error(rpcResponse.error?.message ?? 'Factory state is unavailable.');
    }

    const json = new TextDecoder().decode(Uint8Array.from(rpcResponse.result.result));
    const state = JSON.parse(json) as Partial<FactoryContractState>;
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

  private applyFactoryState(state: FactoryContractState): void {
    this.mintingFeeDisplay.set(this.formatYoctoNear(state.vault_minting_fee));
    this.mintedVaultCount.set(state.vault_counter);
  }

  private formatYoctoNear(amount: string): string {
    const value = BigInt(amount);
    const whole = value / YOCTO_PER_NEAR;
    const fraction = (value % YOCTO_PER_NEAR)
      .toString()
      .padStart(24, '0')
      .replace(/0+$/, '');
    return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''} NEAR`;
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
    this.walletName.set(wallet.manifest.name);
    this.accountId.set(accountId);
    this.errorMessage.set('');
  }

  private clearConnectedWallet(): void {
    this.walletName.set(null);
    this.accountId.set(null);
  }

  private removeConnectorListeners(): void {
    this.connector?.off('wallet:signIn', this.handleWalletSignIn);
    this.connector?.off('wallet:signOut', this.handleWalletSignOut);
    this.connector = null;
  }
}
