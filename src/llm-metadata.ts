/**
 * LLM client for metadata extraction using Mistral-Small with JSON mode
 */

import type { Env, PinaxMetadata, OpenAIUsage } from './types';

// Mistral-Small model for metadata extraction
const METADATA_MODEL = 'mistralai/Mistral-Small-3.2-24B-Instruct-2506';

// Pricing (assuming similar to other Mistral models, adjust if needed)
const INPUT_COST_PER_MILLION = 0.075;   // Estimate - adjust based on actual pricing
const OUTPUT_COST_PER_MILLION = 0.2;  // Estimate - adjust based on actual pricing

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
function buildSystemPrompt(): string {
  return `You are an expert metadata cataloger for archival materials and historical collections.
You extract structured metadata following the PINAX schema, which is based on Dublin Core standards.

Your task is to analyze archival content (directory names, OCR text, descriptions) and extract accurate, structured metadata.

Key guidelines:
- Extract information accurately from the provided content
- Use appropriate DCMI Type vocabulary for the "type" field
- Infer dates from context when possible (use YYYY or YYYY-MM-DD format). Be as specific as possible with the date
- For creators, extract names of people or organizations
- For institutions, identify the owning/issuing body
- For subjects, identify relevant keywords and topics
- For places, identify geographic locations mentioned
- Keep language codes in BCP-47 format (e.g., "en", "en-US", "fr")

Always respond with valid JSON matching the PINAX schema exactly.`;
}

/**
 * Build the user prompt with content and schema
 */
function buildUserPrompt(
  directoryName: string,
  files: Array<{ name: string; content: string }>
): string {
  const contentSection = buildContentSection(directoryName, files);
  const schemaSection = buildSchemaSection();

  return `${contentSection}

${schemaSection}

Extract accurate metadata from the content above. Respond with ONLY valid JSON matching the schema.`;
}

/**
 * Build the content section of the prompt
 */
function buildContentSection(
  directoryName: string,
  files: Array<{ name: string; content: string }>
): string {
  let content = `Extract metadata for this archival item:

**Directory Name:** ${directoryName}`;

  if (files.length > 0) {
    content += `\n\n**Content Files:**\n`;
    files.forEach((file, i) => {
      // Truncate long content but preserve meaningful portions
      const maxLength = 800;
      const truncated = file.content.length > maxLength
        ? file.content.slice(0, maxLength) + '\n... [truncated]'
        : file.content;

      content += `\n--- File: ${file.name} ---\n${truncated}\n`;
    });
  } else {
    content += `\n\n(No additional content provided - extract metadata from directory name and context)\n`;
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
  env: Env
): Promise<MetadataExtractionResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(directoryName, files);

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
