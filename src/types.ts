/**
 * Type definitions for metadata-service
 */

export interface Env {
  DEEPINFRA_API_KEY: string;
  DEEPINFRA_BASE_URL: string;
  MODEL_NAME: string;
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
