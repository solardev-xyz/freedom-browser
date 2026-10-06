/** Restricted snapshot extension, not CreatePluginFn<..., Host>.
 * Declaration syntax only until a real pinned compiler checks this source graph.
 * Callback code is trusted application code. Currency is host-relative.
 */
import type { PluginInstance } from '../../tmp/privacy-build/pinned-inputs/kohaku/packages/plugins/src/base';

export type ReadAsset =
  | { __type: 'native' }
  | { __type: 'erc20'; contract: `0x${string}` }
  | { __type: 'erc721'; contract: `0x${string}`; tokenId: bigint };
export type SnapshotAsset =
  ReadAsset | { __type: 'erc1155'; contract: `0x${string}`; tokenId: bigint };
export interface SnapshotNote {
  id: string;
  tree: number;
  position: number;
  txid: `0x${string}`;
  hash: `0x${string}`;
  tokenHash: `0x${string}`;
  asset: SnapshotAsset;
  amount: bigint;
  tag: 'unverified';
  spentTxid: false | `0x${string}`;
}
export type ReadNote = Omit<SnapshotNote, 'asset'> & { asset: ReadAsset };
export interface ReadAmount {
  asset: ReadAsset;
  amount: bigint;
  tag: 'unverified';
}
export interface SnapshotHost {
  signal: AbortSignal;
  capture(): {
    snapshot: { instanceId: string; received: ReadonlyArray<SnapshotNote> };
    // Exactly undefined at runtime. TS's ordinary void callback assignment alone
    // would also allow value-returning functions, so express the stricter result.
    assertCurrent(): undefined;
  };
}
export type SnapshotExtras = {
  readonly provenance: 'host-supplied';
  readonly signal: AbortSignal;
  readonly closed: Promise<void>;
  close(): void;
};
export type SnapshotReadPlugin = SnapshotExtras & {
  instanceId(): Promise<string>;
  balance(assets?: ReadAsset[]): Promise<ReadAmount[]>;
  notes(assets?: ReadAsset[], includeSpent?: boolean): Promise<ReadNote[]>;
};
export declare function createRailgunKohakuSnapshotPlugin(options: {
  host: SnapshotHost;
  signal: AbortSignal;
}): SnapshotReadPlugin;

// The actual pinned target, not an ambient any substitute. Assignability is NOT
// claimed: a future compiler must resolve the complete alias/provider/ox graph.
export type PinnedReadTarget = PluginInstance<
  string,
  {
    features: {};
    note: ReadNote;
    assetAmounts: { input: ReadAmount; internal: ReadAmount; output: ReadAmount; read: ReadAmount };
    extras: SnapshotExtras;
  }
>;
