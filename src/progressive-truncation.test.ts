/**
 * Unit tests for Progressive Tax Truncation Algorithm
 *
 * Test cases from PROGRESSIVE-TAX-ALGORITHM.md examples
 */

import { describe, it, expect } from 'vitest';
import {
  applyProgressiveTruncation,
  estimateTokens,
  truncateContent,
  type TruncationItem
} from './progressive-truncation';

describe('Progressive Tax Truncation Algorithm', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens using 4 chars per token', () => {
      expect(estimateTokens('test')).toBe(1); // 4 chars = 1 token
      expect(estimateTokens('hello world')).toBe(3); // 11 chars = 3 tokens (rounded up)
      expect(estimateTokens('a'.repeat(400))).toBe(100); // 400 chars = 100 tokens
    });
  });

  describe('truncateContent', () => {
    it('should not truncate content below limit', () => {
      const content = 'short content';
      expect(truncateContent(content, 100)).toBe(content);
    });

    it('should truncate long content with ellipsis', () => {
      const content = 'a'.repeat(1000);
      const result = truncateContent(content, 100);
      expect(result.length).toBe(100);
      expect(result.endsWith('... [truncated]')).toBe(true);
    });
  });

  describe('applyProgressiveTruncation - No Truncation Needed', () => {
    it('should not truncate when already under budget', () => {
      const items: TruncationItem[] = [
        { name: 'file1.txt', content: 'a'.repeat(400), tokens: 100 },
        { name: 'file2.txt', content: 'b'.repeat(400), tokens: 100 }
      ];

      const { results, stats } = applyProgressiveTruncation(items, 1000);

      expect(stats.mode).toBe('no-truncation');
      expect(stats.totalTokensBefore).toBe(200);
      expect(stats.totalTokensAfter).toBe(200);
      expect(stats.itemsProtected).toBe(0);
      expect(stats.itemsTruncated).toBe(0);

      results.forEach((result, i) => {
        expect(result.truncated).toBe(false);
        expect(result.allocatedTokens).toBe(items[i].tokens);
      });
    });
  });

  describe('applyProgressiveTruncation - Example 1: One Giant File', () => {
    it('should protect small files and tax only the giant file', () => {
      // Example from PROGRESSIVE-TAX-ALGORITHM.md line 101-133
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(4000), tokens: 1000 },
        { name: 'file2', content: 'b'.repeat(4000), tokens: 1000 },
        { name: 'file3', content: 'c'.repeat(40000), tokens: 10000 },
        { name: 'file4', content: 'd'.repeat(1200000), tokens: 300000 }
      ];

      const targetTokens = 100000;
      const { results, stats } = applyProgressiveTruncation(items, targetTokens);

      expect(stats.mode).toBe('protection');
      expect(stats.totalTokensBefore).toBe(312000);
      expect(Math.round(stats.totalTokensAfter)).toBe(targetTokens);
      expect(stats.itemsProtected).toBe(3); // file1, file2, file3
      expect(stats.itemsTruncated).toBe(1); // file4

      // Check that small files are protected
      const file1Result = results.find(r => r.name === 'file1')!;
      const file2Result = results.find(r => r.name === 'file2')!;
      const file3Result = results.find(r => r.name === 'file3')!;
      const file4Result = results.find(r => r.name === 'file4')!;

      expect(file1Result.protected).toBe(true);
      expect(file1Result.truncated).toBe(false);
      expect(file1Result.allocatedTokens).toBe(1000);

      expect(file2Result.protected).toBe(true);
      expect(file2Result.truncated).toBe(false);
      expect(file2Result.allocatedTokens).toBe(1000);

      expect(file3Result.protected).toBe(true);
      expect(file3Result.truncated).toBe(false);
      expect(file3Result.allocatedTokens).toBe(10000);

      // file4 should pay the entire deficit
      expect(file4Result.protected).toBe(false);
      expect(file4Result.truncated).toBe(true);
      expect(Math.round(file4Result.allocatedTokens)).toBe(88000);
    });
  });

  describe('applyProgressiveTruncation - Example 2: Multiple Large Files', () => {
    it('should protect small files and proportionally tax large files', () => {
      // Example from PROGRESSIVE-TAX-ALGORITHM.md line 137-175
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(4000), tokens: 1000 },
        { name: 'file2', content: 'b'.repeat(4000), tokens: 1000 },
        { name: 'file3', content: 'c'.repeat(400000), tokens: 100000 },
        { name: 'file4', content: 'd'.repeat(800000), tokens: 200000 }
      ];

      const targetTokens = 100000;
      const { results, stats } = applyProgressiveTruncation(items, targetTokens);

      expect(stats.mode).toBe('protection');
      expect(stats.totalTokensBefore).toBe(302000);
      expect(Math.round(stats.totalTokensAfter)).toBe(targetTokens);
      expect(stats.itemsProtected).toBe(2); // file1, file2
      expect(stats.itemsTruncated).toBe(2); // file3, file4

      const file1Result = results.find(r => r.name === 'file1')!;
      const file2Result = results.find(r => r.name === 'file2')!;
      const file3Result = results.find(r => r.name === 'file3')!;
      const file4Result = results.find(r => r.name === 'file4')!;

      // Small files protected
      expect(file1Result.protected).toBe(true);
      expect(file2Result.protected).toBe(true);

      // Large files taxed proportionally - both should keep same percentage
      expect(file3Result.protected).toBe(false);
      expect(file4Result.protected).toBe(false);

      const file3Percentage = file3Result.allocatedTokens / 100000;
      const file4Percentage = file4Result.allocatedTokens / 200000;

      // Both should keep approximately the same percentage (32.7%)
      expect(Math.abs(file3Percentage - file4Percentage)).toBeLessThan(0.01);
      expect(file3Percentage).toBeCloseTo(0.327, 2);
    });
  });

  describe('applyProgressiveTruncation - Example 3: Many Equal Files', () => {
    it('should tax all files equally when all are above average', () => {
      // Example from PROGRESSIVE-TAX-ALGORITHM.md line 179-205
      // 300 files × 1,000 tokens each = 300,000 tokens → 100,000 target
      const items: TruncationItem[] = Array.from({ length: 300 }, (_, i) => ({
        name: `file${i + 1}`,
        content: 'a'.repeat(4000),
        tokens: 1000
      }));

      const targetTokens = 100000;
      const { results, stats } = applyProgressiveTruncation(items, targetTokens);

      expect(stats.mode).toBe('protection');
      expect(stats.totalTokensBefore).toBe(300000);
      expect(Math.round(stats.totalTokensAfter)).toBe(targetTokens);

      // No files protected because all are above average tax (666.67)
      expect(stats.itemsProtected).toBe(0);
      expect(stats.itemsTruncated).toBe(300);

      // All files should get equal allocation
      results.forEach(result => {
        expect(result.protected).toBe(false);
        expect(result.allocatedTokens).toBeCloseTo(333.33, 1);
      });
    });
  });

  describe('applyProgressiveTruncation - Example 4: Fallback Mode', () => {
    it('should use fallback mode when protection is not feasible', () => {
      // Example from PROGRESSIVE-TAX-ALGORITHM.md line 209-251
      // file1: 149 tokens, file2: 251 tokens, target: 100 tokens
      // Total below (149) > target (100), so protection is NOT feasible
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(596), tokens: 149 },
        { name: 'file2', content: 'b'.repeat(1004), tokens: 251 }
      ];

      const targetTokens = 100;
      const { results, stats } = applyProgressiveTruncation(items, targetTokens);

      expect(stats.mode).toBe('fallback');
      expect(stats.totalTokensBefore).toBe(400);
      expect(Math.round(stats.totalTokensAfter)).toBe(targetTokens);
      expect(stats.itemsProtected).toBe(0); // No protection in fallback mode
      expect(stats.itemsTruncated).toBe(2);

      const file1Result = results.find(r => r.name === 'file1')!;
      const file2Result = results.find(r => r.name === 'file2')!;

      // Both files should keep the same percentage (25%)
      expect(file1Result.protected).toBe(false);
      expect(file2Result.protected).toBe(false);

      const file1Percentage = file1Result.allocatedTokens / 149;
      const file2Percentage = file2Result.allocatedTokens / 251;

      expect(file1Percentage).toBeCloseTo(0.25, 2);
      expect(file2Percentage).toBeCloseTo(0.25, 2);
      expect(file1Result.allocatedTokens).toBeCloseTo(37.25, 1);
      expect(file2Result.allocatedTokens).toBeCloseTo(62.75, 1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle single file', () => {
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(40000), tokens: 10000 }
      ];

      const { results, stats } = applyProgressiveTruncation(items, 5000);

      expect(stats.mode).toBe('protection');
      expect(results.length).toBe(1);
      expect(results[0].allocatedTokens).toBe(5000);
      expect(results[0].truncated).toBe(true);
    });

    it('should handle empty files array', () => {
      const items: TruncationItem[] = [];

      const { results } = applyProgressiveTruncation(items, 1000);

      expect(results.length).toBe(0);
    });

    it('should handle zero target tokens', () => {
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(4000), tokens: 1000 }
      ];

      const { results, stats } = applyProgressiveTruncation(items, 0);

      expect(results[0].allocatedTokens).toBe(0);
      expect(results[0].allocatedChars).toBe(0);
    });

    it('should handle files with zero tokens', () => {
      const items: TruncationItem[] = [
        { name: 'file1', content: '', tokens: 0 },
        { name: 'file2', content: 'a'.repeat(4000), tokens: 1000 }
      ];

      const { results, stats } = applyProgressiveTruncation(items, 500);

      // Should handle gracefully without errors
      expect(results.length).toBe(2);
      expect(stats.totalTokensBefore).toBe(1000);
    });
  });

  describe('Mathematical Guarantees', () => {
    it('should always reach target exactly (within rounding)', () => {
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(4000), tokens: 1000 },
        { name: 'file2', content: 'b'.repeat(40000), tokens: 10000 },
        { name: 'file3', content: 'c'.repeat(200000), tokens: 50000 }
      ];

      const targetTokens = 30000;
      const { results, stats } = applyProgressiveTruncation(items, targetTokens);

      const actualTotal = results.reduce((sum, r) => sum + r.allocatedTokens, 0);

      // Should match target within rounding error
      expect(Math.abs(actualTotal - targetTokens)).toBeLessThan(1);
    });

    it('should never allocate negative tokens', () => {
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(4000), tokens: 1000 },
        { name: 'file2', content: 'b'.repeat(40000), tokens: 10000 }
      ];

      const { results } = applyProgressiveTruncation(items, 5000);

      results.forEach(result => {
        expect(result.allocatedTokens).toBeGreaterThanOrEqual(0);
        expect(result.allocatedChars).toBeGreaterThanOrEqual(0);
      });
    });

    it('should distribute burden fairly among large items', () => {
      // Two files of same size should pay same tax
      const items: TruncationItem[] = [
        { name: 'file1', content: 'a'.repeat(40000), tokens: 10000 },
        { name: 'file2', content: 'b'.repeat(40000), tokens: 10000 }
      ];

      const { results } = applyProgressiveTruncation(items, 10000);

      expect(results[0].allocatedTokens).toBeCloseTo(results[1].allocatedTokens, 1);
    });
  });
});
