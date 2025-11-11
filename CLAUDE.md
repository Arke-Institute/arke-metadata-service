# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Cloudflare Worker** service that extracts and validates PINAX metadata for the Arke Institute photo archive. The service uses LLM-based extraction (Mistral-Small via DeepInfra) to generate Dublin Core-compliant metadata from archival directory contents.

**Core functionality:**
- `/extract-metadata` - LLM-based metadata extraction from directory files (text, OCR, child metadata)
- `/validate-metadata` - Schema validation without LLM calls

**Key technologies:**
- Cloudflare Workers (serverless edge runtime)
- TypeScript with strict mode
- DeepInfra API for LLM access (Mistral-Small-3.2-24B)
- Vitest for testing

## Commands

### Development
```bash
# Start local dev server with wrangler
npm run dev

# Run tests with Vitest
npm run test

# Type check with TypeScript
npm run build
```

### Deployment
```bash
# Deploy to Cloudflare Workers
npm run deploy

# Set API key secret (required for deployment)
wrangler secret put DEEPINFRA_API_KEY
```

## Architecture

### Request Flow
1. **API Entry** (`src/index.ts`) - Routes requests to `/extract-metadata` or `/validate-metadata`
2. **Metadata Extraction** (`src/metadata-extractor.ts`) - Orchestrates LLM extraction, manual overrides, and validation
3. **LLM Client** (`src/llm-metadata.ts`) - Calls DeepInfra API with structured prompts for metadata extraction
4. **Validation** (`src/metadata-validator.ts`) - Validates PINAX schema compliance (required fields, formats, DCMI types)

### Data Flow for Metadata Extraction
```
Request → extractMetadata() → extractMetadataWithLLM() → LLM API
                            ↓
                  Apply manual overrides
                            ↓
                  postProcessMetadata() (normalize dates, types, generate IDs)
                            ↓
                  validatePinaxMetadata()
                            ↓
                         Response
```

### PINAX Schema (see pinax-schema.md for full spec)
- **7 required fields:** id, title, type (DCMI), creator, institution, created, access_url
- **4 optional fields:** language, subjects, description, source, rights, place
- **Dublin Core compliant** - maps to dc:title, dc:creator, dc:type, dcterms:created, etc.
- **Supports hierarchical aggregation** - child `pinax.json` files inform parent metadata

### Key Modules

**src/types.ts**
- TypeScript interfaces for all request/response types
- `PinaxMetadata` interface defines the Dublin Core-based schema
- `Env` interface for Cloudflare Worker environment variables

**src/llm-metadata.ts**
- Builds system/user prompts with PINAX schema instructions
- Calls DeepInfra API with JSON mode for structured outputs
- Truncates file content to 800 chars per file to manage token usage
- Calculates API costs based on token usage

**src/metadata-extractor.ts**
- `postProcessMetadata()` - Normalizes dates, types, generates ULIDs
- Handles manual metadata overrides (user-provided values take precedence)
- Maps common type variations to valid DCMI Types (e.g., "photo" → "StillImage")

**src/metadata-validator.ts**
- Validates required fields, ID formats (ULID/UUID), DCMI types, dates, URLs, BCP-47 language codes
- Returns field-level validation messages with ✓/⚠ symbols
- Generates warnings for missing optional fields (description, subjects, language, source)

## Environment Variables

**Configured in wrangler.jsonc:**
- `DEEPINFRA_BASE_URL` - DeepInfra API endpoint (https://api.deepinfra.com/v1/openai)
- `MODEL_NAME` - LLM model identifier (mistralai/Mistral-Small-3.2-24B-Instruct-2506)

**Set as secrets via wrangler CLI:**
- `DEEPINFRA_API_KEY` - DeepInfra API key (never commit to repo)

## Important Context

### DCMI Type Vocabulary
The `type` field must be one of these exact values (case-sensitive):
- Collection, Dataset, Event, Image, InteractiveResource, MovingImage, PhysicalObject, Service, Software, Sound, StillImage, Text

Common type mappings are handled in `normalizeType()` in metadata-extractor.ts.

### Date Format Normalization
Dates must be either:
- `YYYY` (year only, e.g., "1927")
- `YYYY-MM-DD` (full date, e.g., "1927-06-01")

`normalizeDate()` attempts to extract years from various formats, but validation will catch invalid formats.

### ID Generation
- Uses ULID (26-char Crockford Base32) via the `ulid` package
- Auto-generated in `postProcessMetadata()` if not provided
- Can also accept UUID format for compatibility

### Token Budget Strategy (from pinax-schema.md)
The upstream ingest pipeline uses token budgeting:
- If text files + child metadata < 10,000 tokens → include OCR from .ref.json files
- If ≥ 10,000 tokens → exclude OCR to save costs
- This service receives the pre-filtered input and doesn't need to implement budgeting itself

### Testing Notes
- Tests should use Vitest (`npm run test`)
- Mock the DeepInfra API for LLM extraction tests
- Use sample PINAX metadata from pinax-schema.md for validation tests
- Test edge cases: empty creators array, invalid DCMI types, malformed dates

## Common Patterns

### Adding a new validation rule
1. Add validation function in `src/metadata-validator.ts` (follow existing patterns like `validateId()`, `validateDate()`)
2. Call from `validatePinaxMetadata()` and add to `field_validations` object
3. Add corresponding test case

### Modifying the LLM prompt
1. Update `buildSystemPrompt()` or `buildUserPrompt()` in `src/llm-metadata.ts`
2. Be careful with token usage - prompts are sent for every extraction request
3. Test with real archival content to ensure quality metadata extraction

### Adding a new metadata field
1. Update `PinaxMetadata` interface in `src/types.ts`
2. Add to `REQUIRED_FIELDS` array in `src/metadata-validator.ts` (if required)
3. Update schema documentation in `buildSchemaSection()` in `src/llm-metadata.ts`
4. Update validation logic in `validatePinaxMetadata()`
5. Update pinax-schema.md documentation

## Integration Points

This service is part of the larger Arke Institute ingest pipeline:
- **Called by:** Phase 2 of the ingest pipeline during directory processing
- **Input:** Directory name, text files, child `pinax.json` files, optional OCR from `.ref.json`
- **Output:** Validated PINAX metadata stored as `pinax.json` in IPFS
- **Downstream consumers:** Primo VE (library discovery), Pinecone (vector search), OAI-PMH harvesters

See pinax-schema.md sections on "Primo VE Integration" and "Pinecone Vector Search" for mapping details.
