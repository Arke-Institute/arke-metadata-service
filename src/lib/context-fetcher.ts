/**
 * Fetch PINAX context from IPFS
 *
 * All data is fetched from IPFS via the entity's components.
 * After OCR phase, refs already have OCR text included.
 */

import { IPFSClient, Entity } from '../services/ipfs-client';
import { PinaxContext, PinaxMetadata, Env } from '../types';
import {
  applyProgressiveTruncation,
  estimateTokens,
  truncateContent,
  TruncationItem,
} from '../progressive-truncation';

// Text file extensions to fetch as content
const TEXT_EXTENSIONS = [
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.csv', '.tsv',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
  '.rst', '.tex', '.rtf', '.asc', '.nfo',
];

/**
 * Check if a filename is a text file we should fetch
 */
function isTextFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  // Skip special files that we handle separately
  if (lower === 'pinax.json' || lower === 'cheimarros.json' || lower === 'description.md') {
    return false;
  }
  // Skip ref files (handled separately)
  if (lower.endsWith('.ref.json')) {
    return false;
  }
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Fetch all context needed for PINAX metadata extraction
 */
export async function fetchPinaxContext(
  pi: string,
  ipfsClient: IPFSClient,
  env: Env
): Promise<PinaxContext> {
  const entity = await ipfsClient.getEntity(pi);
  const files: Array<{ name: string; content: string }> = [];
  let existingPinax: PinaxMetadata | undefined;

  // 1. Fetch existing pinax.json if present (for reprocessing/update context)
  if (entity.components['pinax.json']) {
    try {
      const content = await ipfsClient.downloadContent(entity.components['pinax.json']);
      existingPinax = JSON.parse(content);
      files.push({ name: '[PREVIOUS] pinax.json', content });
      console.log(`[ContextFetcher] Including existing PINAX as context for ${pi}`);
    } catch (e) {
      console.warn(`[ContextFetcher] Failed to fetch existing pinax.json for ${pi}: ${e}`);
    }
  }

  // 2. Fetch all text files from components (in parallel)
  const textFilePromises: Promise<void>[] = [];
  for (const [filename, cid] of Object.entries(entity.components)) {
    if (isTextFile(filename)) {
      textFilePromises.push(
        (async () => {
          try {
            const content = await ipfsClient.downloadContent(cid);
            files.push({ name: filename, content });
          } catch (e) {
            console.warn(`[ContextFetcher] Failed to fetch text file ${filename} for ${pi}: ${e}`);
          }
        })()
      );
    }
  }
  await Promise.all(textFilePromises);

  // 3. Fetch all refs from IPFS (includes OCR after OCR phase)
  const refPromises: Promise<void>[] = [];
  for (const [filename, cid] of Object.entries(entity.components)) {
    if (filename.endsWith('.ref.json')) {
      refPromises.push(
        (async () => {
          try {
            const content = await ipfsClient.downloadContent(cid);
            files.push({ name: filename, content });
          } catch (e) {
            console.warn(`[ContextFetcher] Failed to fetch ref ${filename} for ${pi}: ${e}`);
          }
        })()
      );
    }
  }
  await Promise.all(refPromises);

  // 4. Fetch child pinax.json files (children must be processed first due to bottom-up order)
  if (entity.children_pi && entity.children_pi.length > 0) {
    const childPromises = entity.children_pi.map(async (childPi, index) => {
      try {
        const childEntity = await ipfsClient.getEntity(childPi);
        if (childEntity.components['pinax.json']) {
          const content = await ipfsClient.downloadContent(
            childEntity.components['pinax.json']
          );
          // Use a descriptive name that shows this is from a child
          const childName = childEntity.label || childPi.slice(-8);
          files.push({
            name: `child_pinax_${childName}.json`,
            content,
          });
        }
      } catch (e) {
        console.warn(`[ContextFetcher] Failed to fetch child ${childPi} pinax: ${e}`);
      }
    });
    await Promise.all(childPromises);
  }

  // 5. Apply progressive truncation to fit token budget
  const truncatedFiles = applyTruncation(files, env);

  // Directory name: use label from entity or last 8 chars of PI
  const directoryName = entity.label || pi.slice(-8);

  console.log(
    `[ContextFetcher] Fetched context for ${pi}: ${truncatedFiles.length} files ` +
      `(pinax: ${entity.components['pinax.json'] ? 'yes' : 'no'}, ` +
      `refs: ${Object.keys(entity.components).filter((k) => k.endsWith('.ref.json')).length}, ` +
      `children: ${entity.children_pi?.length || 0})`
  );

  return {
    directory_name: directoryName,
    files: truncatedFiles,
    existing_pinax: existingPinax,
  };
}

/**
 * Apply progressive truncation to fit within token budget
 */
function applyTruncation(
  files: Array<{ name: string; content: string }>,
  env: Env
): Array<{ name: string; content: string }> {
  // Calculate target tokens from env config
  const modelMaxTokens = parseInt(env.MODEL_MAX_TOKENS || '128000');
  const contentProportion = parseFloat(env.CONTENT_TOKEN_PROPORTION || '0.5');
  const targetTokens = Math.floor(modelMaxTokens * contentProportion);

  // Build truncation items
  const items: TruncationItem[] = files.map((f) => ({
    name: f.name,
    content: f.content,
    tokens: estimateTokens(f.content),
  }));

  // Apply progressive truncation
  const { results, stats } = applyProgressiveTruncation(items, targetTokens);

  console.log(
    `[ContextFetcher] Truncation: ${stats.totalTokensBefore} -> ${stats.totalTokensAfter} tokens ` +
      `(target: ${stats.targetTokens}, mode: ${stats.mode}, ` +
      `protected: ${stats.itemsProtected}, truncated: ${stats.itemsTruncated})`
  );

  // Apply truncation to content
  return results.map((r) => ({
    name: r.name,
    content: r.truncated ? truncateContent(r.content, r.allocatedChars) : r.content,
  }));
}
