/**
 * PINAX metadata validation logic
 */

import type { PinaxMetadata, ValidationResult } from './types';

// Required fields in PINAX schema
const REQUIRED_FIELDS: (keyof PinaxMetadata)[] = [
  'id',
  'title',
  'type',
  'creator',
  'institution',
  'created',
  'access_url'
];

// Valid DCMI Type vocabulary
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

// Common BCP-47 language codes (not exhaustive, but covers most cases)
const COMMON_LANGUAGE_CODES = [
  'en', 'en-US', 'en-GB', 'es', 'es-MX', 'fr', 'fr-CA', 'de', 'it', 'pt', 'pt-BR',
  'zh', 'zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'ru', 'hi', 'nl', 'pl', 'tr', 'sv'
];

/**
 * Validate PINAX metadata completeness and correctness
 */
export function validatePinaxMetadata(metadata: Partial<PinaxMetadata>): ValidationResult {
  const missing_required: string[] = [];
  const warnings: string[] = [];
  const field_validations: Record<string, string> = {};

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    const value = metadata[field];

    if (value === undefined || value === null || value === '') {
      missing_required.push(field);
    } else if (field === 'creator' && Array.isArray(value) && value.length === 0) {
      missing_required.push(field);
    }
  }

  // Validate individual fields if present
  if (metadata.id) {
    field_validations.id = validateId(metadata.id);
  }

  if (metadata.type) {
    field_validations.type = validateDCMIType(metadata.type);
  }

  if (metadata.created) {
    field_validations.created = validateDate(metadata.created);
  }

  if (metadata.language) {
    field_validations.language = validateLanguageCode(metadata.language);
  }

  if (metadata.access_url) {
    field_validations.access_url = validateUrl(metadata.access_url);
  }

  // Generate warnings for optional but recommended fields
  if (!metadata.description) {
    warnings.push('Consider adding a description for better discoverability');
  }

  if (!metadata.subjects || metadata.subjects.length === 0) {
    warnings.push('Consider adding subjects/keywords for better searchability');
  }

  if (!metadata.language) {
    warnings.push('Consider specifying the language (e.g., "en", "en-US")');
  }

  if (!metadata.source) {
    warnings.push('Consider specifying the source system');
  }

  const valid = missing_required.length === 0;

  return {
    valid,
    missing_required,
    warnings,
    field_validations
  };
}

/**
 * Validate ID format (ULID or UUID)
 */
function validateId(id: string): string {
  // ULID: 26 characters, alphanumeric (Crockford's Base32)
  const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

  // UUID: 8-4-4-4-12 hexadecimal
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (ulidPattern.test(id)) {
    return '✓ Valid ULID format';
  } else if (uuidPattern.test(id)) {
    return '✓ Valid UUID format';
  } else {
    return '⚠ Not a valid ULID or UUID format';
  }
}

/**
 * Validate DCMI Type
 */
function validateDCMIType(type: string): string {
  if (DCMI_TYPES.includes(type)) {
    return '✓ Valid DCMI Type';
  } else {
    return `⚠ Should be one of: ${DCMI_TYPES.join(', ')}`;
  }
}

/**
 * Validate date format (YYYY or YYYY-MM-DD)
 */
function validateDate(date: string): string {
  // YYYY format
  const yearPattern = /^\d{4}$/;

  // YYYY-MM-DD format
  const fullDatePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (yearPattern.test(date)) {
    const year = parseInt(date, 10);
    if (year >= 1000 && year <= 9999) {
      return '✓ Valid year format (YYYY)';
    }
  }

  if (fullDatePattern.test(date)) {
    // Basic date validation
    const [year, month, day] = date.split('-').map(Number);

    if (year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      // Check if it's a valid date
      const dateObj = new Date(date);
      if (!isNaN(dateObj.getTime())) {
        return '✓ Valid date format (YYYY-MM-DD)';
      }
    }
  }

  return '⚠ Invalid date format (should be YYYY or YYYY-MM-DD)';
}

/**
 * Validate BCP-47 language code
 */
function validateLanguageCode(lang: string): string {
  // Basic BCP-47 pattern (simplified)
  const bcp47Pattern = /^[a-z]{2,3}(-[A-Z]{2})?$/;

  if (!bcp47Pattern.test(lang)) {
    return '⚠ Invalid BCP-47 format (should be like "en", "en-US", "fr-CA")';
  }

  if (COMMON_LANGUAGE_CODES.includes(lang)) {
    return '✓ Valid BCP-47 language code';
  } else {
    return '✓ Valid BCP-47 format (uncommon code)';
  }
}

/**
 * Validate URL format
 */
function validateUrl(url: string): string {
  try {
    const urlObj = new URL(url);

    if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
      return '✓ Valid URL';
    } else {
      return '⚠ URL should use http:// or https://';
    }
  } catch {
    return '⚠ Invalid URL format';
  }
}

/**
 * Quick validation - just checks if required fields are present
 */
export function hasRequiredFields(metadata: Partial<PinaxMetadata>): boolean {
  for (const field of REQUIRED_FIELDS) {
    const value = metadata[field];

    if (value === undefined || value === null || value === '') {
      return false;
    }

    if (field === 'creator' && Array.isArray(value) && value.length === 0) {
      return false;
    }
  }

  return true;
}

/**
 * Get list of missing required fields
 */
export function getMissingRequiredFields(metadata: Partial<PinaxMetadata>): string[] {
  const missing: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = metadata[field];

    if (value === undefined || value === null || value === '') {
      missing.push(field);
    } else if (field === 'creator' && Array.isArray(value) && value.length === 0) {
      missing.push(field);
    }
  }

  return missing;
}
