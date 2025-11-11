# Metadata Service

Cloudflare Worker for PINAX metadata extraction and validation for the Arke Institute photo archive.

## Features

- **Metadata Extraction**: LLM-based extraction of structured PINAX metadata using Mistral-Small
- **Metadata Validation**: Validate PINAX metadata completeness and format
- **Dublin Core Compliance**: Based on Dublin Core standards with DCMI Type vocabulary

## Endpoints

### POST /extract-metadata

Extract structured PINAX metadata from directory content using LLM.

**Request:**
```json
{
  "directory_name": "string",
  "files": [
    {
      "name": "string",
      "content": "string"
    }
  ],
  "access_url": "string (optional)",
  "manual_metadata": {
    // Optional partial metadata to override LLM outputs
  }
}
```

**Response:**
```json
{
  "metadata": {
    "id": "ULID",
    "title": "string",
    "type": "DCMI Type",
    "creator": "string or array",
    "institution": "string",
    "created": "YYYY or YYYY-MM-DD",
    "access_url": "URL",
    // ... optional fields
  },
  "validation": {
    "valid": true,
    "missing_required": [],
    "warnings": []
  },
  "cost_usd": 0.00123,
  "tokens": 456,
  "model": "mistralai/Mistral-Small-3.2-24B-Instruct-2506"
}
```

### POST /validate-metadata

Validate PINAX metadata completeness and format (no LLM call).

**Request:**
```json
{
  "metadata": {
    // PINAX metadata object
  }
}
```

**Response:**
```json
{
  "valid": true,
  "missing_required": [],
  "warnings": [],
  "field_validations": {
    "id": "✓ Valid ULID format",
    "type": "✓ Valid DCMI Type",
    // ...
  }
}
```

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy

# Set API key
wrangler secret put DEEPINFRA_API_KEY
```

## Configuration

Environment variables are set in `wrangler.jsonc`:
- `DEEPINFRA_BASE_URL`: DeepInfra API endpoint
- `MODEL_NAME`: Mistral-Small-3.2-24B-Instruct-2506
- `DEEPINFRA_API_KEY`: Set as secret via wrangler CLI

## PINAX Schema

See `pinax-schema.md` for detailed documentation of the PINAX metadata schema.
