/**
 * Shared TypeScript interfaces for fountain feedback payloads.
 * These enforce the presence of the sequence field and document the schema.
 */

/**
 * Part completion feedback payload - signals that a part has been decoded and validated.
 * This is the primary feedback mode for part-based transfers.
 */
export interface FountainFeedback {
  /** Always 'FOUNTAIN_FEEDBACK' */
  type: 'FOUNTAIN_FEEDBACK';
  /** Always 'part-complete' (targeted mode removed) */
  mode: 'part-complete';
  /** Session ID to match feedback with sender */
  sessionId: number;
  /** Sequence number to prevent duplicate processing */
  sequence: number;
  /** Current part index that was completed (0-indexed) */
  currentPart: number;
  /** Total number of parts in the file */
  totalParts: number;
  /** Whether the decoded part's checksum matches the expected checksum */
  isValid: boolean;
  /** Expected checksum from sender (CRC32 hex string) */
  expectedChecksum: string;
  /** Computed checksum of the decoded part (CRC32 hex string) */
  actualChecksum: string;
}

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
