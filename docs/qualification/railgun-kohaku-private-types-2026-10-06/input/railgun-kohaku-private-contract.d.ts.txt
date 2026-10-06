/** Restricted private host extension. Host callbacks own crypto/state/authority.
 * Native Promise, bounds, one-use identity and genuine ownership are runtime
 * contracts; these structural types alone cannot authenticate any of them.
 */
import type { PluginInstance } from '../../tmp/privacy-build/pinned-inputs/kohaku/packages/plugins/src/base';
import type { Broadcaster } from '../../tmp/privacy-build/pinned-inputs/kohaku/packages/plugins/src/broadcaster/base';
import type { ReadAsset, ReadAmount, ReadNote } from './railgun-kohaku-snapshot-contract';
export type { ReadAsset, ReadAmount, ReadNote } from './railgun-kohaku-snapshot-contract';

export interface PrivateInput {
  asset: { __type: 'erc20'; contract: `0x${string}` };
  amount: bigint;
  noteId: string;
}
declare const privateOperation: unique symbol;
export interface PrivateOperation {
  readonly __type: 'privateOperation';
  readonly [privateOperation]: true;
}
export type PrivateUnshieldOptions = { tailCalls?: never };
export type PrivateSubmissionOutcome =
  | {
      hash: `0x${string}`;
      nonce: number;
      from: `0x${string}`;
      to: `0x${string}`;
      value: '0';
      chainId: 11155111;
      broadcastSource: 'direct';
      explorerUrl: string | null;
    }
  | { transactionHash: `0x${string}`; submissionStatus: 'unknown' }
  | {
      status: 'recovery-required';
      stage:
        | 'completion'
        | 'recovery'
        | 'proof'
        | 'preflight'
        | 'eoa'
        | 'submission'
        | 'kohaku'
        | 'review-draining'
        | 'adapter-contract';
    };
export type PrivateHostHandle = Readonly<Record<string, never>>;
export interface RestrictedPrivateHost {
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  instanceId(): Promise<string>;
  balance(assets?: ReadonlyArray<ReadAsset>): Promise<ReadonlyArray<ReadAmount>>;
  notes(
    assets?: ReadonlyArray<ReadAsset>,
    includeSpent?: boolean
  ): Promise<ReadonlyArray<ReadNote>>;
  prepareTransfer(value: PrivateInput, to: string): Promise<{ handle: PrivateHostHandle }>;
  prepareUnshield(
    value: PrivateInput,
    to: `0x${string}`,
    options?: PrivateUnshieldOptions
  ): Promise<{ handle: PrivateHostHandle }>;
  broadcast(handle: PrivateHostHandle): Promise<PrivateSubmissionOutcome>;
  close(): undefined;
}
export type PrivateAdapterExtras = {
  readonly provenance: 'host-supplied';
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  close(): undefined;
};
export type PrivateAdapter = PrivateAdapterExtras & {
  instanceId(): Promise<string>;
  balance(assets?: ReadAsset[]): Promise<ReadAmount[]>;
  notes(assets?: ReadAsset[], includeSpent?: boolean): Promise<ReadNote[]>;
  prepareTransfer(value: PrivateInput, to: string): Promise<PrivateOperation>;
  prepareUnshield(
    value: PrivateInput,
    to: `0x${string}`,
    options?: PrivateUnshieldOptions
  ): Promise<PrivateOperation>;
};
export type PrivateCapabilities = {
  features: { prepareTransfer: true; prepareUnshield: true };
  privateOp: PrivateOperation;
  assetAmounts: {
    input: PrivateInput;
    internal: PrivateInput;
    output: PrivateInput;
    read: ReadAmount;
  };
  note: ReadNote;
  extras: PrivateAdapterExtras;
};
export type PinnedPrivateTarget = PluginInstance<string, PrivateCapabilities>;
export type PrivateAdapterBroadcaster = Broadcaster<PrivateOperation, PrivateSubmissionOutcome>;
export declare function createRailgunKohakuPrivateAdapter(options: {
  host: RestrictedPrivateHost;
  signal: AbortSignal;
}): PrivateAdapter;
export declare function createRailgunKohakuPrivateAdapterBroadcaster(
  adapter: PrivateAdapter
): PrivateAdapterBroadcaster;
