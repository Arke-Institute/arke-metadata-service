# PINAX Metadata Schema

## Overview

PINAX is a **Dublin Core-based metadata schema** designed for describing archival content at the Arke Institute. The schema enables structured, searchable metadata extraction from heterogeneous archival materials through LLM-based analysis.

**Key Characteristics:**
- **11 fields total:** 7 required, 4 optional
- **Dublin Core compliant:** Maps cleanly to OAI-PMH/DC and Dublin Core Terms
- **Library system compatible:** Designed for integration with Primo VE and other discovery systems
- **Vector search ready:** Includes Pinecone filter keys for semantic search
- **LLM-generated:** Metadata extracted automatically from directory contents (text files, OCR, child metadata)

## Schema Purpose

PINAX metadata serves multiple purposes:
1. **Discovery & Search:** Enable users to find archival materials through keywords, subjects, creators, dates, etc.
2. **Interoperability:** Provide Dublin Core-compliant metadata for harvesting by library systems, aggregators, and search engines
3. **Context Preservation:** Capture essential provenance, creation context, and rights information
4. **Hierarchical Aggregation:** Support bottom-up metadata generation where child directories inform parent descriptions

## Generation Workflow

PINAX metadata is generated during **Phase 2** of the ingest pipeline:

1. **Input Gathering:**
   - All text files in directory (README, CSV, JSON, etc.) - full content
   - `.ref.json` files for binary assets (with or without OCR text, depending on token budget)
   - `pinax.json` from all child subdirectories (bottom-up aggregation)

2. **Token Budget Logic:**
   ```
   textTokens = estimate(text_files + child_pinax_content)

   if textTokens >= 10,000:
     → Exclude OCR from .ref.json files (save tokens)
   else:
     → Include OCR in .ref.json files (more context)
   ```

3. **LLM Extraction:**
   - All inputs sent to arke-description-service `/extract-metadata` endpoint
   - LLM analyzes content and generates structured PINAX metadata
   - Automatic validation ensures required fields and format compliance

4. **Storage:**
   - Saved as `pinax.json` in directory's IPFS component
   - Versioned in IPFS for immutability
   - Cached in processing tree for parent aggregation

## Field Reference

| Field         | Type                                                 | Required | What it's for                    | Map to Dublin Core (OAI/DC)                       | Primo VE notes                                                   | Pinecone filter key (examples)                    |
| ------------- | ---------------------------------------------------- | -------: | -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `id`          | string (ULID/UUID)                                   |        ✅ | Stable source record ID          | `dc:identifier` (URI or literal)                  | Map to `sourcerecordid`; `sourceid` is set in the Import Profile | `id`                                              |
| `title`       | string                                               |        ✅ | Display title                    | `dc:title`                                        | Maps to `display/title`                                          | `title` (optional facet)                          |
| `type`        | string (DCMI Type)                                   |        ✅ | Facets/badges                    | `dc:type` (use DCMI Type vocabulary)              | Map to Discovery Type; use VE resource-type mapping table        | `type` (= `"Text"`, `"Image"`, etc.)              |
| `creator`     | string \| string[]                                   |   ✅ (≥1) | People/orgs who authored/created | `dc:creator` (repeatable)                         | Goes to creators; simple strings for now; IDs for future linking | `creator` (first value for filtering)             |
| `institution` | string                                               |        ✅ | Owning/issuing body              | `dc:publisher` **or** `dc:contributor`            | Drives display & facets if you map it                            | `institution`                                     |
| `created`     | string (date `YYYY-MM-DD` or `YYYY`)                 |        ✅ | Creation date of the item        | `dcterms:created` (or `dc:date`)                  | Mappable to display/ facets                                      | `year` (int), `created` (string)                  |
| `language`    | string (BCP-47, e.g. `en`, `en-US`)                  |        — | Language facet                   | `dc:language`                                     | Useful for VE language facets                                    | `lang`                                            |
| `subjects`    | string[]                                             |        — | Keywords/topics                  | `dc:subject` (repeatable)                         | Simple topical facets                                            | `subjects` (array)                                |
| `description` | string                                               |        — | Short abstract                   | `dc:description`                                  | Display snippet                                                  | —                                                 |
| `access_url`  | string (URL)                                         |        ✅ | Click-through link               | `dc:identifier` (URI) **or** `dcterms:identifier` | In VE Import Profile, use this for "Link to Resource"            | `url`                                             |
| `source`      | string                                               |        — | Source system label              | `dcterms:isPartOf` or `dc:source`                 | Also set VE *Originating system* = `"PINAX"`                     | `source`                                          |
| `rights`      | string                                               |        — | Rights statement                 | `dc:rights`                                       | Display                                                          | —                                                 |
| `place`       | string \| string[]                                   |        — | Where it was made/about          | `dcterms:spatial`                                 | Optional facet/map                                               | `place` (array ok)                                |

## Detailed Field Specifications

### Required Fields

#### `id` (string)
- **Format:** ULID (26 characters, Crockford Base32) or UUID (8-4-4-4-12 hex format)
- **Purpose:** Globally unique, stable identifier for this record
- **Generation:** Auto-generated ULID during metadata extraction
- **Validation:**
  - ULID: `/^[0-9A-HJKMNP-TV-Z]{26}$/i`
  - UUID: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
- **Example:** `"01K8W0AG70YQWM0ESYWV3FY5SR"`

#### `title` (string)
- **Format:** Free text, human-readable
- **Purpose:** Primary display title for the resource
- **Guidance:** Should be descriptive and concise (typically 5-100 characters)
- **LLM Extraction:** Derived from directory name, file names, document titles, or content analysis
- **Example:** `"Federal Reserve Committee on Branch, Group and Chain Banking - Form A-3"`

#### `type` (string)
- **Format:** Controlled vocabulary from **DCMI Type Vocabulary**
- **Purpose:** Resource type for faceting, filtering, and display badges
- **Valid Values:**
  - `Collection` - Aggregation of resources
  - `Dataset` - Structured data
  - `Event` - Time-based occurrence
  - `Image` - Static visual representation
  - `InteractiveResource` - Interactive content
  - `MovingImage` - Video, film
  - `PhysicalObject` - Material object
  - `Service` - System providing functions
  - `Software` - Computer programs
  - `Sound` - Audio content
  - `StillImage` - Photograph, scan
  - `Text` - Textual content (most common for archival documents)
- **Validation:** Must exactly match one of the above values (case-sensitive)
- **Example:** `"Text"`

#### `creator` (string | string[])
- **Format:** String or array of strings representing person/organization names
- **Purpose:** Attribution for authorship or creation
- **Cardinality:** At least one creator required (array must have length ≥ 1)
- **Guidance:**
  - Use full names when available ("Jane Smith" not "J. Smith")
  - For organizations, use official name
  - Future: May support structured format `{name: string, id?: URI}` for linked data
- **Example:**
  - Single: `"Federal Reserve Committee on Branch, Group and Chain Banking"`
  - Multiple: `["Jane Smith", "John Doe"]`

#### `institution` (string)
- **Format:** String representing institution name
- **Purpose:** Identify the owning, holding, or issuing organization
- **Guidance:** Use official institution name
- **Future:** May support structured format `{name: string, id?: URI}` for linked data
- **Example:** `"National Archives"`

#### `created` (string)
- **Format:** ISO 8601 date string, partial dates allowed
- **Purpose:** Date of creation/publication of the original resource (not the digital surrogate)
- **Valid Formats:**
  - Year only: `YYYY` (e.g., `"1927"`)
  - Full date: `YYYY-MM-DD` (e.g., `"1927-06-01"`)
- **Validation:**
  - Year: `/^\d{4}$/` with value between 1000-9999
  - Full date: `/^\d{4}-\d{2}-\d{2}$/` with valid month (1-12) and day (1-31)
  - Must parse as valid Date object
- **Guidance:** Use most specific date available; year-only is acceptable for older materials
- **Example:** `"1927-06-01"` or `"1927"`

#### `access_url` (string)
- **Format:** Valid HTTP/HTTPS URL
- **Purpose:** Link to the resource for click-through access
- **Validation:** Must parse as valid URL with `http://` or `https://` protocol
- **Generation:** Typically constructed as `https://arke.institute/{id}`
- **Example:** `"https://arke.institute/01K8W0AG70YQWM0ESYWV3FY5SR"`

### Optional Fields (Recommended)

#### `language` (string)
- **Format:** BCP-47 language code
- **Purpose:** Primary language of the resource content
- **Validation:** Basic pattern `/^[a-z]{2,3}(-[A-Z]{2})?$/`
- **Common Values:** `en`, `en-US`, `es`, `es-MX`, `fr`, `de`, `zh`, `ja`, etc.
- **Guidance:** Use most specific code available (prefer `en-US` over `en` if known)
- **Warning:** Generates warning if omitted during validation
- **Example:** `"en"`

#### `subjects` (string[])
- **Format:** Array of keyword strings
- **Purpose:** Topical subjects, themes, or keywords for search and faceting
- **Guidance:**
  - Use 3-10 subjects for optimal discoverability
  - Include specific and general terms
  - Prefer standardized vocabularies (LCSH, AAT) when applicable
  - Avoid redundancy with title
- **Warning:** Generates warning if empty/omitted during validation
- **Example:** `["Banking", "Financial institutions", "Indiana", "Bank changes", "Bank liquidation"]`

#### `description` (string)
- **Format:** Free text, typically 1-3 sentences
- **Purpose:** Short abstract or summary for display
- **Guidance:**
  - Should complement title, not repeat it
  - Include key context: what, when, why, who
  - Aim for 50-300 characters
- **Warning:** Generates warning if omitted during validation
- **Example:** `"Form A-3 from the Federal Reserve Committee on Branch, Group and Chain Banking reporting bank changes during 1921-1930 in Indiana."`

#### `source` (string)
- **Format:** Free text label
- **Purpose:** Identify the source system or collection
- **Guidance:**
  - Use for collection name, finding aid ID, or system identifier
  - Typically set to `"PINAX"` for PINAX-generated records
- **Warning:** Generates warning if omitted during validation
- **Example:** `"PINAX"`

### Optional Fields (Situational)

#### `rights` (string)
- **Format:** Free text or standardized rights statement
- **Purpose:** Copyright, licensing, or access restrictions
- **Guidance:**
  - Prefer standardized statements (e.g., RightsStatements.org URIs)
  - Common values: `"PUBLIC DOMAIN"`, `"IN COPYRIGHT"`, `"NO COPYRIGHT - US"`
  - Include usage terms if applicable
- **Example:** `"PUBLIC DOMAIN"`

#### `place` (string | string[])
- **Format:** String or array of strings representing geographic locations
- **Purpose:** Geographic coverage - where the resource was created or what it's about
- **Guidance:**
  - Use specific to general (city, state, country)
  - Prefer standardized place names (GeoNames, LCNAF)
  - Can include multiple locations for multi-site coverage
- **Example:**
  - Single: `"Indiana"`
  - Multiple: `["Indianapolis", "Indiana", "United States"]`

## Validation Rules

The schema includes comprehensive validation implemented in `src/metadata-validator.ts`:

### Required Field Validation
- All 7 required fields must be present and non-empty
- `creator` array must have at least one element if provided as array
- Returns `missing_required` array listing any missing fields

### Format Validation
- **ID:** Must match ULID or UUID pattern
- **Type:** Must be one of 11 valid DCMI Types (exact match, case-sensitive)
- **Created:** Must match YYYY or YYYY-MM-DD pattern with valid date values
- **Language:** Must match BCP-47 pattern (basic validation)
- **Access URL:** Must parse as valid HTTP/HTTPS URL

### Warnings (Non-blocking)
- Missing `description` → "Consider adding a description for better discoverability"
- Empty/missing `subjects` → "Consider adding subjects/keywords for better searchability"
- Missing `language` → "Consider specifying the language (e.g., 'en', 'en-US')"
- Missing `source` → "Consider specifying the source system"

### Validation Response Format
```typescript
{
  valid: boolean,                      // true if all required fields present
  missing_required: string[],          // Array of missing required field names
  warnings: string[],                  // User-friendly warning messages
  field_validations: {                 // Field-level validation results
    id: "✓ Valid ULID format",
    type: "✓ Valid DCMI Type",
    created: "✓ Valid date format (YYYY-MM-DD)",
    // ...
  }
}
```

## Example Record

```json
{
  "id": "01K8W0AG70YQWM0ESYWV3FY5SR",
  "title": "Federal Reserve Committee on Branch, Group and Chain Banking - Form A-3",
  "type": "Text",
  "creator": "Federal Reserve Committee on Branch, Group and Chain Banking",
  "institution": "National Archives",
  "created": "1927-06-01",
  "language": "en",
  "subjects": [
    "Banking",
    "Financial institutions",
    "Indiana",
    "Bank changes",
    "Bank liquidation"
  ],
  "description": "Form A-3 from the Federal Reserve Committee on Branch, Group and Chain Banking reporting bank changes during 1921-1930 in Indiana.",
  "access_url": "https://arke.institute/01K8W0AG70YQWM0ESYWV3FY5SR",
  "source": "PINAX",
  "rights": "PUBLIC DOMAIN",
  "place": "Indiana"
}
```

## TypeScript Type Definition

```typescript
export interface PinaxMetadata {
  id: string;                      // ULID or UUID - stable source record ID
  title: string;                   // Display title
  type: string;                    // DCMI Type vocabulary
  creator: string | string[];      // People/orgs who created
  institution: string;             // Owning/issuing institution
  created: string;                 // Creation date (YYYY-MM-DD or YYYY)
  language?: string;               // BCP-47 language code (e.g., "en", "en-US")
  subjects?: string[];             // Keywords/topics
  description?: string;            // Short abstract
  access_url: string;              // Click-through link
  source?: string;                 // Source system label
  rights?: string;                 // Rights statement
  place?: string | string[];       // Geographic location(s)
}
```

## Integration Points

### Dublin Core / OAI-PMH Mapping
- **`dc:identifier`** ← `id`, `access_url`
- **`dc:title`** ← `title`
- **`dc:type`** ← `type` (DCMI Type vocabulary)
- **`dc:creator`** ← `creator` (repeatable)
- **`dc:publisher`** ← `institution`
- **`dcterms:created`** ← `created`
- **`dc:language`** ← `language`
- **`dc:subject`** ← `subjects` (repeatable)
- **`dc:description`** ← `description`
- **`dc:rights`** ← `rights`
- **`dcterms:spatial`** ← `place`
- **`dcterms:isPartOf`** ← `source`

### Primo VE Integration
- **`sourcerecordid`** ← `id`
- **`display/title`** ← `title`
- **Discovery Type** ← `type` (via VE resource-type mapping table)
- **Creators** ← `creator`
- **Publisher** ← `institution`
- **Date facets** ← `created`
- **Language facets** ← `language`
- **Subject facets** ← `subjects`
- **Link to Resource** ← `access_url`
- **Originating System** ← `"PINAX"` (set in Import Profile)

### Pinecone Vector Search
Metadata fields used as filters in semantic search:
- `id` - Exact record lookup
- `type` - Filter by resource type ("Text", "Image", etc.)
- `creator` - Filter by creator name (first value if array)
- `institution` - Filter by owning institution
- `year` - Numeric year extracted from `created` for range queries
- `created` - Full date string for precise filtering
- `lang` - Language code for language-specific search
- `subjects` - Keyword array for topic filtering
- `place` - Geographic filtering (array support)
- `source` - Filter by collection/source system
- `url` - Direct access link retrieval

## API Endpoints

### Extract Metadata
**POST** `/extract-metadata`

Generate PINAX metadata from directory contents using LLM analysis.

**Request:**
```typescript
{
  directory_name: string;
  files: TextFile[];                        // Array of {name, content} objects
  access_url?: string;                      // Optional, can be generated
  manual_metadata?: Partial<PinaxMetadata>; // User-provided overrides
}
```

**Response:**
```typescript
{
  metadata: PinaxMetadata;        // Generated metadata
  validation: ValidationResult;   // Validation status and warnings
  cost_usd: number;              // LLM API cost
  tokens: number;                // Total tokens used
  model: string;                 // Model identifier
}
```

### Validate Metadata
**POST** `/validate-metadata`

Validate existing PINAX metadata against schema rules.

**Request:**
```typescript
{
  metadata: PinaxMetadata;
}
```

**Response:**
```typescript
{
  valid: boolean;
  missing_required: string[];
  warnings: string[];
  field_validations: Record<string, string>;
}
```

## Design Principles

1. **Dublin Core Foundation:** All fields map cleanly to Dublin Core elements for maximum interoperability
2. **Simplicity First:** Simple string types preferred over complex objects (future enhancement possible)
3. **Required Minimum:** Only 7 required fields ensure metadata generation always succeeds
4. **Flexible Arrays:** Key fields (`creator`, `subjects`, `place`) support both single and multiple values
5. **Validation Warnings:** Non-required fields generate warnings to encourage richer metadata
6. **Standardized Vocabularies:** Use controlled vocabularies (DCMI Type, BCP-47) where applicable
7. **Future-Proof:** Schema can evolve (e.g., structured creator/institution with IDs) without breaking changes

## Best Practices

### For LLM Extraction
- Analyze all available context (text files, OCR, child metadata)
- Extract creator/institution from letterheads, signatures, document headers
- Derive subjects from content themes, not just explicit keywords
- Use full dates when mentioned in content, fall back to year-only
- Infer language from content, default to `"en"` for US archival materials

### For Manual Metadata
- Always provide all 7 required fields
- Include `description` for better discoverability
- Add 3-10 `subjects` for optimal search coverage
- Specify `language` even if obvious (enables language facets)
- Use `rights` to clarify usage permissions
- Add `place` for geographic materials

### For System Integration
- Validate all metadata before storage/transmission
- Log validation warnings for quality monitoring
- Cache metadata for parent aggregation in hierarchical processing
- Version metadata in IPFS for immutability and auditability
- Include PINAX schema version in export formats for forward compatibility
