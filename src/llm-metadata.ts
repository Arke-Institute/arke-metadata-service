/**
 * LLM client for metadata extraction using Mistral-Small with JSON mode
 */

import type { Env, PinaxMetadata, OpenAIUsage } from './types';
import { applyProgressiveTruncation, estimateTokens, truncateContent, type TruncationItem } from './progressive-truncation';

// Mistral-Small model for metadata extraction
const METADATA_MODEL = 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';

// Pricing (assuming similar to other Mistral models, adjust if needed)
const INPUT_COST_PER_MILLION = 0.075;   // Estimate - adjust based on actual pricing
const OUTPUT_COST_PER_MILLION = 0.2;  // Estimate - adjust based on actual pricing

// Default token budget configuration
// Mistral-Small-3.2-24B has 128k context window
const DEFAULT_MODEL_MAX_TOKENS = 128000;
// Default: use 78% of context for content (~100k tokens)
// Remaining 22% for system prompt, schema, output, and safety margin
const DEFAULT_CONTENT_TOKEN_PROPORTION = 0.5;

// DCMI Type vocabulary
const DCMI_TYPES = [
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

interface MetadataExtractionResult {
  metadata: Partial<PinaxMetadata>;
  tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  model: string;
}

interface OpenAIRequestWithJSON {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  max_tokens: number;
  temperature: number;
  response_format?: {
    type: 'json_object';
  };
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: OpenAIUsage;
}

/**
 * Calculate cost in USD based on token usage
 */
function calculateCost(usage: OpenAIUsage): number {
  const inputCost = (usage.prompt_tokens / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (usage.completion_tokens / 1_000_000) * OUTPUT_COST_PER_MILLION;
  return inputCost + outputCost;
}

/**
 * Build the system prompt for metadata extraction
 */
function buildSystemPrompt(customPrompt?: string): string {
  let prompt = `You are an expert metadata cataloger for archival materials and historical collections.
You extract structured metadata following the PINAX schema, which is based on Dublin Core standards.

Your task is to analyze archival content (directory names, OCR text, descriptions) and extract accurate, structured metadata.

IMPORTANT - Collection-First Approach:
- You are almost ALWAYS cataloging a COLLECTION of materials, not a single item
- Default to type "Collection" unless you are certain it's a single standalone item
- Create titles that describe the ENTIRE collection of files, not just the first or most prominent one
- Titles should identify the common theme, series name, creator, time period, or unifying characteristic
- NEVER use a single file's title as the collection title - synthesize a broader title
- Example: Multiple "Chartbook" newsletters → "Chartbook Newsletter Collection"
- Example: Multiple photos from an event → "Event Name Photo Collection" or "[Subject] Photographs"
- Aggregate subjects, creators, and places from ALL files to represent the full scope
- Use date ranges when content spans multiple dates (e.g., "2021-2023")

Files named "child_pinax_*.json" indicate nested sub-collections - aggregate their metadata into the parent.

Only use specific types (Text, Image, StillImage, etc.) when there is truly ONE item with no related files.

Key guidelines:
- Extract information accurately from the provided content
- Use appropriate DCMI Type vocabulary for the "type" field
- Infer dates from context when possible (use YYYY or YYYY-MM-DD format). Be as specific as possible with the date
- For creators, extract names of people or organizations
- For institutions, identify the owning/issuing body
- For subjects, identify relevant keywords and topics (for collections, aggregate from all children)
- For places, identify geographic locations mentioned
- Keep language codes in BCP-47 format (e.g., "en", "en-US", "fr")

Always respond with valid JSON matching the PINAX schema exactly.`;

  if (customPrompt) {
    prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${customPrompt}`;
  }

  return prompt;
}

/**
 * Build the user prompt with content and schema
 */
function buildUserPrompt(
  directoryName: string,
  files: Array<{ name: string; content: string }>,
  env: Env
): string {
  const contentSection = buildContentSection(directoryName, files, env);
  const schemaSection = buildSchemaSection();

  return `${contentSection}

${schemaSection}

Extract accurate metadata from the content above. Respond with ONLY valid JSON matching the schema.`;
}

/**
 * Build the content section of the prompt with progressive truncation
 */
function buildContentSection(
  directoryName: string,
  files: Array<{ name: string; content: string }>,
  env: Env
): string {
  let content = `Extract metadata for this archival item:

**Directory Name:** ${directoryName}`;

  if (files.length === 0) {
    content += `\n\n(No additional content provided - extract metadata from directory name and context)\n`;
    return content;
  }

  // Calculate target token budget from model max tokens and proportion
  const modelMaxTokens = env.MODEL_MAX_TOKENS
    ? parseInt(env.MODEL_MAX_TOKENS, 10)
    : DEFAULT_MODEL_MAX_TOKENS;

  const contentProportion = env.CONTENT_TOKEN_PROPORTION
    ? parseFloat(env.CONTENT_TOKEN_PROPORTION)
    : DEFAULT_CONTENT_TOKEN_PROPORTION;

  const targetTokens = Math.floor(modelMaxTokens * contentProportion);

  // Apply progressive tax truncation to fit within token budget
  const truncationItems: TruncationItem[] = files.map(file => ({
    name: file.name,
    content: file.content,
    tokens: estimateTokens(file.content)
  }));

  const { results, stats } = applyProgressiveTruncation(truncationItems, targetTokens);

  // Build content section with truncated files
  content += `\n\n**Content Files:**\n`;

  for (const result of results) {
    const displayContent = result.truncated
      ? truncateContent(result.content, result.allocatedChars)
      : result.content;

    content += `\n--- File: ${result.name} ---\n${displayContent}\n`;
  }

  // Add truncation stats as a comment (helpful for debugging)
  if (stats.mode !== 'no-truncation') {
    content += `\n(Token budget: ${stats.totalTokensBefore} → ${stats.totalTokensAfter} tokens, `;
    content += `${stats.itemsProtected} protected, ${stats.itemsTruncated} truncated, mode: ${stats.mode})`;
  }

  return content;
}

/**
 * Build the schema section of the prompt
 */
function buildSchemaSection(): string {
  return `**Required PINAX Schema:**

{
  "id": "string - leave as empty string, will be generated",
  "title": "string - descriptive title for this item",
  "type": "string - DCMI Type (choose one): ${DCMI_TYPES.join(', ')}",
  "creator": "string or array of strings - people/organizations who created this",
  "institution": "string - owning or issuing institution",
  "created": "string - creation date in YYYY-MM-DD or YYYY format",
  "language": "string - BCP-47 language code like 'en' or 'en-US' (optional)",
  "subjects": "array of strings - keywords and topics (optional)",
  "description": "string - short abstract or summary (optional)",
  "access_url": "string - leave as empty string, will be provided separately",
  "source": "string - source system, use 'PINAX' if unknown (optional)",
  "rights": "string - rights statement if mentioned (optional)",
  "place": "string or array of strings - geographic locations (optional)"
}`;
}

/**
 * Call the metadata extraction LLM with JSON mode
 */
export async function extractMetadataWithLLM(
  directoryName: string,
  files: Array<{ name: string; content: string }>,
  env: Env,
  customPrompt?: string
): Promise<MetadataExtractionResult> {
  const systemPrompt = buildSystemPrompt(customPrompt);
  const userPrompt = buildUserPrompt(directoryName, files, env);

  const requestBody: OpenAIRequestWithJSON = {
    model: METADATA_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 1024,
    temperature: 0.2,  // Lower temperature for more consistent extraction
    response_format: { type: 'json_object' }
  };

  const response = await fetch(`${env.DEEPINFRA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DEEPINFRA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Metadata LLM API error (${response.status}): ${errorText}`);
  }

  const data: OpenAIResponse = await response.json();

  if (!data.choices || data.choices.length === 0) {
    throw new Error('Metadata LLM API returned no choices');
  }

  const content = data.choices[0].message.content;

  // Parse the JSON response
  let metadata: Partial<PinaxMetadata>;
  try {
    metadata = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse metadata JSON: ${e instanceof Error ? e.message : 'Unknown error'}`);
  }

  return {
    metadata,
    tokens: data.usage.total_tokens,
    prompt_tokens: data.usage.prompt_tokens,
    completion_tokens: data.usage.completion_tokens,
    cost_usd: calculateCost(data.usage),
    model: METADATA_MODEL
  };
}
