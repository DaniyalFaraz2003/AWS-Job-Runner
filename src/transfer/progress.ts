/** Progress hooks for ora spinners and byte counters (FR-PUSH-5). */
export interface TransferProgressHandlers {
  readonly onArchiveStart?: () => void;
  readonly onArchiveProgress?: (processedBytes: number) => void;
  readonly onArchiveComplete?: (totalBytes: number) => void;
  readonly onUploadStart?: (totalBytes: number) => void;
  readonly onUploadProgress?: (transferred: number, total: number) => void;
  readonly onUploadComplete?: () => void;
  readonly onUnzipStart?: () => void;
  readonly onUnzipComplete?: () => void;
  readonly onPullStart?: (artifactPath: string) => void;
  readonly onPullComplete?: (artifactPath: string, localPath: string) => void;
}
