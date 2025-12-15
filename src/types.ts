/**
 * Type definitions for metadata-service
 */

// === Environment ===

export interface Env {
  // Secrets
  DEEPINFRA_API_KEY: string;

  // LLM Config
  DEEPINFRA_BASE_URL: string;
  MODEL_NAME: string;
  MODEL_MAX_TOKENS: string;         // Model's maximum context window (e.g., "128000")
  CONTENT_TOKEN_PROPORTION: string; // Proportion of context for content (e.g., "0.5" for 50%)

  // DO Config
  MAX_RETRIES_PER_PI?: string;
  MAX_CALLBACK_RETRIES?: string;
  ALARM_INTERVAL_MS?: string;

  // Bindings
  IPFS_WRAPPER: Fetcher;
  ORCHESTRATOR: Fetcher;
  PINAX_BATCH_DO: DurableObjectNamespace;
}

// PINAX Metadata Schema (Dublin Core based)
export interface PinaxMetadata {
  id: string;                      // ULID or UUID - stable source record ID
  title: string;                   // Display title
  type: string;                    // DCMI Type vocabulary
  creator: string | string[];      // People/orgs who created (simple strings for now)
  institution: string;             // Owning/issuing institution (simple string for now)
  created: string;                 // Creation date (YYYY-MM-DD or YYYY)
  language?: string;               // BCP-47 language code (e.g., "en", "en-US")
  subjects?: string[];             // Keywords/topics
  description?: string;            // Short abstract
  access_url: string;              // Click-through link
  source?: string;                 // Source system label
  rights?: string;                 // Rights statement
  place?: string | string[];       // Geographic location(s)
}

// Flexible file input - can be any text content (JSON, XML, TXT, CSV, etc.)
export interface TextFile {
  name: string;      // File name or identifier
  content: string;   // Raw text content
}

export interface ExtractMetadataRequest {
  directory_name: string;
  files: TextFile[];                         // Array of text files with raw content
  access_url?: string;                       // Optional, can be generated
  manual_metadata?: Partial<PinaxMetadata>;  // User overrides
  custom_prompt?: string;                    // Optional custom instructions for this specific request
}

export interface ExtractMetadataResponse {
  metadata: PinaxMetadata;
  validation: ValidationResult;
  cost_usd: number;
  tokens: number;
  model: string;
}

export interface ValidationResult {
  valid: boolean;
  missing_required: string[];
  warnings: string[];
  field_validations?: Record<string, string>;
}

export interface ValidateMetadataRequest {
  metadata: PinaxMetadata;
}

export interface OpenAIUsage {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

// === Batch Processing (DO Pattern) ===

export interface ProcessRequest {
  batch_id: string;
  chunk_id: string;
  r2_prefix: string;
  custom_prompt?: string;
  institution?: string;  // Force institution in output

  pis: Array<{
    pi: string;
    // NOTE: No current_tip - services must fetch fresh tips from IPFS
    // to avoid stale tip bugs from bidirectional parent-child updates
  }>;
}

export interface CallbackPayload {
  batch_id: string;
  chunk_id: string;
  status: 'success' | 'partial' | 'error';

  results: Array<{
    pi: string;
    status: 'success' | 'error';
    new_tip?: string;
    new_version?: number;
    error?: string;
  }>;

  summary: {
    total: number;
    succeeded: number;
    failed: number;
    processing_time_ms: number;
  };

  error?: string;
}

// === DO State Types ===

export type Phase = 'PENDING' | 'PROCESSING' | 'PUBLISHING' | 'CALLBACK' | 'DONE' | 'ERROR';

export interface PIState {
  pi: string;
  // NOTE: No current_tip stored - fetch fresh from IPFS before each update
  status: 'pending' | 'processing' | 'done' | 'error';
  retry_count: number;

  // Cached context (for retries)
  context?: PinaxContext;

  // Result
  pinax?: PinaxMetadata;
  pinax_cid?: string;
  new_tip?: string;
  new_version?: number;

  // Error
  error?: string;
}

export interface BatchState {
  // Identity
  batch_id: string;
  chunk_id: string;
  r2_prefix: string;
  custom_prompt?: string;
  institution?: string;

  // State machine
  phase: Phase;
  started_at: string;
  completed_at?: string;

  // PI list (just the PI identifiers - full state stored separately per-PI)
  pi_list: string[];

  // Callback tracking
  callback_retry_count: number;

  // Global error
  global_error?: string;
}

// === Context Types ===

export interface PinaxContext {
  directory_name: string;
  files: Array<{ name: string; content: string }>;
  existing_pinax?: PinaxMetadata;  // For updates/reprocessing
}
