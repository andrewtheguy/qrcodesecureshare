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
  /** Current window start block index */
  windowStart?: number;
  /** Current window end block index */
  windowEnd?: number;
  /** Overall progress percentage (0-100) */
  progress?: number;
  /** First missing block index (contiguous prefix) */
  firstMissingBlock: number;
}

/**
 * Statistics mode feedback payload - compact format for early transfer stages.
 */
export interface FountainFeedbackStatistics extends FountainFeedbackBase {
  mode: 'statistics';
  /** Number of blocks decoded in current window */
  decodedInWindow?: number;
  /** Total number of blocks decoded so far */
  totalDecoded?: number;
  /** Whether sender should expand the transfer window */
  requestWindowExpansion: boolean;
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
  /** Whether the window was expanded */
  windowExpanded: boolean;
}


/**
 * Union type for all sender feedback payloads.
 */
export type SenderFeedback = SenderFeedbackAcknowledge;