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
  /** Either 'part-complete' or 'targeted' */
  mode: 'part-complete' | 'targeted';
  /** Session ID to match feedback with sender */
  sessionId: number;
  /** Sequence number to prevent duplicate processing */
  sequence: number;
}

/**
 * Part completion feedback payload - signals that a part has been decoded and validated.
 * This is the primary feedback mode for part-based transfers.
 */
export interface FountainFeedbackPartComplete extends FountainFeedbackBase {
  mode: 'part-complete';
  /** Current part index that was completed (0-indexed) */
  currentPart: number;
  /** Total number of parts in the file */
  totalParts: number;
  /** Whether the decoded part's checksum matches the expected checksum */
  partChecksumMatch: boolean;
  /** Computed checksum of the decoded part (CRC32 hex string) */
  computedChecksum?: string;
}

/**
 * Targeted mode feedback payload - includes missing block indices for final cleanup.
 * Used when only a few blocks remain missing (≤10 blocks).
 */
export interface FountainFeedbackTargeted extends FountainFeedbackBase {
  mode: 'targeted';
  /** Array of missing block indices that need to be sent */
  missingBlocks: number[];
  /** Current part index being decoded (0-indexed) */
  currentPart: number;
  /** Total number of parts in the file */
  totalParts: number;
}

/**
 * Union type for all fountain feedback payloads.
 */
export type FountainFeedback = FountainFeedbackPartComplete | FountainFeedbackTargeted;

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
