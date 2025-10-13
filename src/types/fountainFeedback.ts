/**
 * Shared TypeScript interfaces for fountain feedback payloads.
 * These enforce the presence of the sequence field and document the schema.
 */

/**
 * Base interface for fountain feedback payloads.
 */
interface FountainFeedbackBase {
  /** Always 'FOUNTAIN_FEEDBACK' */
  type: 'FOUNTAIN_FEEDBACK';
  /** Either 'statistics' or 'targeted' */
  mode: 'statistics' | 'targeted';
  /** Session ID to match feedback with sender */
  sessionId: number;
  /** Sequence number to prevent duplicate processing */
  sequence: number;
  /** Total number of source blocks */
  totalBlocks: number;
  /** Current window start block index */
  windowStart: number;
  /** Current window end block index */
  windowEnd: number;
  /** Overall progress percentage (0-100) */
  progress: number;
  /** First missing block index (contiguous prefix) */
  firstMissingBlock: number;
  /** Blocks needing urgent decoding */
  defragTargets: number[];
  /** Severity metric (0-1) */
  fragmentationScore: number;
  /** CRC32 of contiguous prefix */
  contiguousChecksum: string;
  /** Range covered by checksum */
  contiguousChecksumRange: [number, number];
  /** Indicates receiver has decoded all defrag targets */
  defragComplete?: boolean;
}

/**
 * Statistics mode feedback payload - compact format for early transfer stages.
 */
export interface FountainFeedbackStatistics extends FountainFeedbackBase {
  mode: 'statistics';
  /** Number of blocks decoded in current window */
  decodedInWindow: number;
  /** Total number of blocks decoded so far */
  totalDecoded: number;
  /** Whether sender should expand the transfer window */
  requestWindowExpansion: boolean;
}

/**
 * Targeted mode feedback payload - includes full block list for final transfer stages.
 */
export interface FountainFeedbackTargeted extends FountainFeedbackBase {
  mode: 'targeted';
  /** Array of decoded block indices */
  receivedBlocks: number[];
}

/**
 * Union type for all fountain feedback payloads.
 */
export type FountainFeedback = FountainFeedbackStatistics | FountainFeedbackTargeted;

/**
 * Base interface for sender feedback payloads.
 */
interface SenderFeedbackBase {
  /** Always 'SENDER_FEEDBACK' */
  type: 'SENDER_FEEDBACK';
  /** Session ID to match feedback with receiver */
  sessionId: number;
  /** Sequence number to prevent duplicate processing */
  sequence: number;
  /** Action for receiver to take */
  command: 'defrag_complete' | 'rollback' | 'acknowledge';
}

/**
 * Sender feedback for defragmentation completion.
 */
export interface SenderFeedbackDefragComplete extends SenderFeedbackBase {
  command: 'defrag_complete';
  /** Which blocks were successfully targeted */
  completedTargets: number[];
  /** Human-readable status message */
  message: string;
}

/**
 * Sender feedback for rollback request.
 */
export interface SenderFeedbackRollback extends SenderFeedbackBase {
  command: 'rollback';
  /** Receiver should discard blocks >= this index */
  rollbackToBlock: number;
  /** Why rollback is needed */
  reason: string;
  /** Checksum of blocks [0, rollbackToBlock) */
  lastValidChecksum: string;
  /** Explicit range covered by checksum */
  lastValidChecksumRange: [number, number];
}

/**
 * Sender feedback for acknowledgment.
 */
export interface SenderFeedbackAcknowledge extends SenderFeedbackBase {
  command: 'acknowledge';
  /** Which receiver feedback was processed */
  acknowledgedSequence: number;
  /** Status message */
  message: string;
}

/**
 * Union type for all sender feedback payloads.
 */
export type SenderFeedback = SenderFeedbackDefragComplete | SenderFeedbackRollback | SenderFeedbackAcknowledge;