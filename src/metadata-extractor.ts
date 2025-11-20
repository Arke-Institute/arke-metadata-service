/**
 * Metadata extraction orchestrator
 * Combines LLM extraction, manual overrides, and validation
 */

import { ulid } from 'ulid';
import type {
  Env,
  ExtractMetadataRequest,
  ExtractMetadataResponse,
  PinaxMetadata
} from './types';
import { extractMetadataWithLLM } from './llm-metadata';
import { validatePinaxMetadata } from './metadata-validator';

/**
 * Extract metadata from directory content with LLM and manual overrides
 */
export async function extractMetadata(
  request: ExtractMetadataRequest,
  env: Env
): Promise<ExtractMetadataResponse> {
  // 1. Call LLM to extract metadata from files
  const llmResult = await extractMetadataWithLLM(
    request.directory_name,
    request.files,
    env,
    request.custom_prompt
  );

  // 2. Build final metadata by merging LLM output with manual overrides
  let metadata = { ...llmResult.metadata } as Partial<PinaxMetadata>;

  // Apply manual overrides (these take precedence)
  if (request.manual_metadata) {
    metadata = {
      ...metadata,
      ...request.manual_metadata
    };
  }

  // 3. Post-process and ensure required fields
  metadata = postProcessMetadata(metadata, request);

  // 4. Validate the final metadata
  const validation = validatePinaxMetadata(metadata);

  // 5. Cast to PinaxMetadata if valid (or keep as partial if invalid)
  const finalMetadata = metadata as PinaxMetadata;

  return {
    metadata: finalMetadata,
    validation,
    cost_usd: llmResult.cost_usd,
    tokens: llmResult.tokens,
    model: llmResult.model
  };
}

/**
 * Post-process metadata to ensure consistency and fill in required fields
 */
function postProcessMetadata(
  metadata: Partial<PinaxMetadata>,
  request: ExtractMetadataRequest
): Partial<PinaxMetadata> {
  const processed = { ...metadata };

  // Generate ID if not present
  if (!processed.id || processed.id === '') {
    processed.id = ulid();
  }

  // Set access_url from request if provided
  if (request.access_url && (!processed.access_url || processed.access_url === '')) {
    processed.access_url = request.access_url;
  }

  // If access_url is still empty, generate a placeholder
  if (!processed.access_url || processed.access_url === '') {
    processed.access_url = `https://arke.institute/${processed.id}`;
  }

  // Set default source if not present
  if (!processed.source || processed.source === '') {
    processed.source = 'PINAX';
  }

  // Ensure creator is normalized (convert single string to array if needed for consistency)
  // Actually, keep it flexible - can be string or array per schema
  if (processed.creator && typeof processed.creator === 'string' && processed.creator.trim() === '') {
    delete processed.creator;  // Remove empty creator
  }

  // Clean up empty arrays
  if (processed.subjects && Array.isArray(processed.subjects) && processed.subjects.length === 0) {
    delete processed.subjects;
  }

  // Validate and clean date format
  if (processed.created) {
    processed.created = normalizeDate(processed.created);
  }

  // Validate and clean type (ensure it's a valid DCMI Type)
  if (processed.type) {
    processed.type = normalizeType(processed.type);
  }

  return processed;
}

/**
 * Normalize date to YYYY or YYYY-MM-DD format
 */
function normalizeDate(date: string): string {
  // Remove any extra whitespace
  date = date.trim();

  // If already in correct format, return as-is
  if (/^\d{4}$/.test(date) || /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }

  // Try to extract year from various formats
  const yearMatch = date.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    return yearMatch[0];
  }

  // If we can't parse it, return as-is (will be caught by validation)
  return date;
}

/**
 * Normalize type to valid DCMI Type
 */
function normalizeType(type: string): string {
  const validTypes = [
    'Collection',
    'Dataset',
    'Event',
    'Image',
    'InteractiveResource',
    'MovingImage',
    'PhysicalObject',
    'Service',
    'Software',
    'Sound',
    'StillImage',
    'Text'
  ];

  // Check if it's already valid
  if (validTypes.includes(type)) {
    return type;
  }

  // Try case-insensitive match
  const lowerType = type.toLowerCase();
  for (const validType of validTypes) {
    if (validType.toLowerCase() === lowerType) {
      return validType;
    }
  }

  // Try to map common variations
  const typeMap: Record<string, string> = {
    'photo': 'StillImage',
    'photograph': 'StillImage',
    'picture': 'StillImage',
    'img': 'Image',
    'images': 'Image',
    'video': 'MovingImage',
    'movie': 'MovingImage',
    'film': 'MovingImage',
    'audio': 'Sound',
    'recording': 'Sound',
    'document': 'Text',
    'book': 'Text',
    'article': 'Text',
    'manuscript': 'Text',
    'object': 'PhysicalObject',
    'artifact': 'PhysicalObject'
  };

  const mapped = typeMap[lowerType];
  if (mapped) {
    return mapped;
  }

  // If we can't map it, return as-is (will be caught by validation)
  return type;
}
