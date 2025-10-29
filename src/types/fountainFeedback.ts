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
  totalBlocks?: number;
  /**
   * Overall file decode progress as a rounded integer from 0 to 100.
   */
  progress: number;
  /** First missing block index (contiguous prefix) */
  firstMissingBlock: number;

  // Part-based transfer fields (optional, used when part-based mode is enabled)
  /** Current part index being decoded (0-indexed) */
  currentPart?: number;
  /** Total number of parts in the file */
  totalParts?: number;
  /** Whether the current part has been fully decoded */
  partComplete?: boolean;
  /** Whether the decoded part's checksum matches the expected checksum */
  partChecksumMatch?: boolean;
  /** Computed checksum of the decoded part (CRC32 hex string) */
  computedChecksum?: string;
  /** Array of completed part indices */
  completedParts?: number[];
}

/**
 * Statistics mode feedback payload - compact format for early transfer stages.
 */
export interface FountainFeedbackStatistics extends FountainFeedbackBase {
  mode: 'statistics';
}

/**
 * Targeted mode feedback payload - includes missing block indices for final transfer stages.
 */
export interface FountainFeedbackTargeted extends FountainFeedbackBase {
  mode: 'targeted';
  /** Array of missing block indices that need to be sent */
  missingBlocks: number[];
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
  command: 'acknowledge';
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

  // Part-based transfer fields (optional, used when part-based mode is enabled)
  /** Whether the sender is moving to the next part */
  partTransition?: boolean;
  /** New part index after transition */
  newPartIndex?: number;
}


/**
 * Union type for all sender feedback payloads.
 */
export type SenderFeedback = SenderFeedbackAcknowledge;
