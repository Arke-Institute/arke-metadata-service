/**
 * Progressive Tax Truncation Algorithm
 *
 * Distributes token budget "fairly" across files by:
 * - Protecting small files (below average tax threshold)
 * - Proportionally truncating large files
 * - Falling back to proportional taxation when protection is infeasible
 *
 * See PROGRESSIVE-TAX-ALGORITHM.md for detailed explanation
 */

export interface TruncationItem {
  name: string;           // File identifier
  content: string;        // Original content
  tokens: number;         // Estimated token count
}

export interface TruncationResult {
  name: string;           // File identifier
  content: string;        // Original content
  allocatedTokens: number; // Tokens allocated to this item
  allocatedChars: number;  // Characters allocated (tokens × 4)
  truncated: boolean;      // Whether item was truncated
  protected: boolean;      // Whether item was protected (below average)
}

export interface TruncationStats {
  totalTokensBefore: number;
  totalTokensAfter: number;
  targetTokens: number;
  itemsProtected: number;
  itemsTruncated: number;
  mode: 'protection' | 'fallback' | 'no-truncation';
}

/**
 * Apply progressive tax truncation to items to fit within target token budget
 *
 * @param items - Array of items with content and token estimates
 * @param targetTokens - Target token budget to fit within
 * @returns Array of truncation results with allocated token/char limits
 */
export function applyProgressiveTruncation(
  items: TruncationItem[],
  targetTokens: number
): { results: TruncationResult[], stats: TruncationStats } {

  // Step 1: Calculate total and deficit
  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0);
  const deficit = totalTokens - targetTokens;

  // No truncation needed
  if (deficit <= 0) {
    return {
      results: items.map(item => ({
        name: item.name,
        content: item.content,
        allocatedTokens: item.tokens,
        allocatedChars: item.content.length,
        truncated: false,
        protected: false
      })),
      stats: {
        totalTokensBefore: totalTokens,
        totalTokensAfter: totalTokens,
        targetTokens,
        itemsProtected: 0,
        itemsTruncated: 0,
        mode: 'no-truncation'
      }
    };
  }

  // Step 2: Calculate average tax per item
  const averageTax = deficit / items.length;

  // Step 3: Split into below-average and above-average groups
  const belowAverage = items.filter(item => item.tokens < averageTax);
  const aboveAverage = items.filter(item => item.tokens >= averageTax);

  // Step 4: Check if protection is feasible
  const totalBelow = belowAverage.reduce((sum, item) => sum + item.tokens, 0);

  if (totalBelow > targetTokens) {
    // Protection NOT feasible - everyone pays proportionally (fallback mode)
    return applyFallbackMode(items, totalTokens, deficit, targetTokens);
  }

  // Protection IS feasible - apply protection mode
  return applyProtectionMode(
    items,
    belowAverage,
    aboveAverage,
    deficit,
    targetTokens,
    totalTokens
  );
}

/**
 * Protection mode: tax only above-average items, protect below-average items
 */
function applyProtectionMode(
  allItems: TruncationItem[],
  belowAverage: TruncationItem[],
  aboveAverage: TruncationItem[],
  deficit: number,
  targetTokens: number,
  totalTokens: number
): { results: TruncationResult[], stats: TruncationStats } {

  const totalAbove = aboveAverage.reduce((sum, item) => sum + item.tokens, 0);

  // Create lookup for quick access
  const itemMap = new Map<string, TruncationItem>();
  allItems.forEach(item => itemMap.set(item.name, item));

  const results: TruncationResult[] = [];

  // Process above-average items (apply tax)
  for (const item of aboveAverage) {
    const proportion = item.tokens / totalAbove;
    const tax = proportion * deficit;
    const finalTokens = item.tokens - tax;
    const finalChars = Math.floor(finalTokens * 4); // tokens to chars (4 chars ≈ 1 token)

    results.push({
      name: item.name,
      content: item.content,
      allocatedTokens: finalTokens,
      allocatedChars: finalChars,
      truncated: finalChars < item.content.length,
      protected: false
    });
  }

  // Process below-average items (protected)
  for (const item of belowAverage) {
    results.push({
      name: item.name,
      content: item.content,
      allocatedTokens: item.tokens,
      allocatedChars: item.content.length,
      truncated: false,
      protected: true
    });
  }

  return {
    results,
    stats: {
      totalTokensBefore: totalTokens,
      totalTokensAfter: targetTokens,
      targetTokens,
      itemsProtected: belowAverage.length,
      itemsTruncated: aboveAverage.length,
      mode: 'protection'
    }
  };
}

/**
 * Fallback mode: everyone pays proportionally
 */
function applyFallbackMode(
  items: TruncationItem[],
  totalTokens: number,
  deficit: number,
  targetTokens: number
): { results: TruncationResult[], stats: TruncationStats } {

  const results: TruncationResult[] = [];

  for (const item of items) {
    const proportion = item.tokens / totalTokens;
    const tax = proportion * deficit;
    const finalTokens = item.tokens - tax;
    const finalChars = Math.floor(finalTokens * 4); // tokens to chars

    results.push({
      name: item.name,
      content: item.content,
      allocatedTokens: finalTokens,
      allocatedChars: finalChars,
      truncated: finalChars < item.content.length,
      protected: false
    });
  }

  return {
    results,
    stats: {
      totalTokensBefore: totalTokens,
      totalTokensAfter: targetTokens,
      targetTokens,
      itemsProtected: 0,
      itemsTruncated: items.length,
      mode: 'fallback'
    }
  };
}

/**
 * Estimate token count from text (using 4 chars ≈ 1 token heuristic)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate content to specified character limit with ellipsis
 */
export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const ellipsis = '\n... [truncated]';
  const truncateAt = maxChars - ellipsis.length;

  return content.slice(0, truncateAt) + ellipsis;
}
