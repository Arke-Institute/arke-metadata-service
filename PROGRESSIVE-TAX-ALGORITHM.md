# Progressive Tax Truncation Algorithm

## Overview

A simple, elegant algorithm for truncating content to fit within token limits. The algorithm distributes the "burden" of truncation fairly across all items, protecting small items while proportionally reducing large items.

## The Problem

You have N items (files, child graphs, etc.) with varying token counts. The total exceeds your target budget. You need to reduce the total to fit the budget while:
- Being fair to all items
- Preserving as much content as possible
- Keeping small items intact
- Distributing cuts proportionally among large items

## The Algorithm

### Step 1: Calculate the Deficit
```
Total Tokens = sum of all item tokens
Deficit = Total Tokens - Target Budget
```

If deficit ≤ 0, we're already under budget. Return items unchanged.

### Step 2: Calculate "Average Tax Per Item"
```
Average Tax = Deficit ÷ Number of Items
```

This represents the "fair share" each item would pay if everyone contributed equally.

### Step 3: Split Items into Two Groups

**Below Average:** Items with tokens < Average Tax
- These items would be **protected** (keep all tokens)
- They're small, so we prefer not to truncate them

**Above Average:** Items with tokens ≥ Average Tax
- These items are large enough to pay the deficit

### Step 4: Check if Protection is Feasible

Calculate the total tokens held by below-average items:
```
Total Below-Average = sum of tokens for below-average items
```

**Feasibility Check:**
```
If Total Below-Average ≤ Target Budget:
  → Protection is feasible (proceed to Step 5)

If Total Below-Average > Target Budget:
  → Protection is NOT feasible
  → EVERYONE must pay proportionally (skip to Step 7)
```

**Why this check?** If the "protected" small items already exceed the target, we can't reach the target by only taxing large items. Everyone must contribute.

### Step 5: Tax Above-Average Items Proportionally (Protection Mode)

Calculate total tokens in above-average group:
```
Total Above-Average = sum of tokens for above-average items
```

For each above-average item:
```
Proportion = Item Tokens ÷ Total Above-Average Tokens
Tax = Proportion × Deficit
Final Tokens = Item Tokens - Tax
```

The bigger the item's share of the "above-average pie", the more it pays.

### Step 6: Below-Average Items Keep Everything (Protection Mode)
```
For each below-average item:
  Final Tokens = Item Tokens (unchanged)
```

Done! Skip to results.

### Step 7: Everyone Pays Proportionally (Fallback Mode)

If protection is not feasible, tax all items proportionally:

```
For each item:
  Proportion = Item Tokens ÷ Total Tokens
  Tax = Proportion × Deficit
  Final Tokens = Item Tokens - Tax
```

Everyone loses the same percentage of their tokens.

---

## Examples

### Example 1: One Giant File

**Input:**
- file1: 1,000 tokens
- file2: 1,000 tokens
- file3: 10,000 tokens
- file4: 300,000 tokens
- **Total: 312,000 tokens**
- **Target: 100,000 tokens**

**Calculation:**
```
Deficit: 312,000 - 100,000 = 212,000 tokens

Average Tax: 212,000 ÷ 4 = 53,000 per item

Below Average (< 53k): file1, file2, file3
Above Average (≥ 53k): file4

Total Above: 300,000 tokens

file4 pays:
  Proportion: 300,000 ÷ 300,000 = 100%
  Tax: 100% × 212,000 = 212,000
  Final: 300,000 - 212,000 = 88,000 tokens
```

**Result:**
- file1: 1,000 (kept fully)
- file2: 1,000 (kept fully)
- file3: 10,000 (kept fully)
- file4: 88,000 (paid 212k)
- **Total: 100,000 ✅**

---

### Example 2: Multiple Large Files

**Input:**
- file1: 1,000 tokens
- file2: 1,000 tokens
- file3: 100,000 tokens
- file4: 200,000 tokens
- **Total: 302,000 tokens**
- **Target: 100,000 tokens**

**Calculation:**
```
Deficit: 202,000 tokens
Average Tax: 202,000 ÷ 4 = 50,500 per item

Below Average: file1, file2
Above Average: file3, file4

Total Above: 300,000 tokens

file3 pays:
  Proportion: 100,000 ÷ 300,000 = 33.33%
  Tax: 33.33% × 202,000 = 67,333
  Final: 100,000 - 67,333 = 32,667 tokens

file4 pays:
  Proportion: 200,000 ÷ 300,000 = 66.67%
  Tax: 66.67% × 202,000 = 134,667
  Final: 200,000 - 134,667 = 65,333 tokens
```

**Result:**
- file1: 1,000 (protected)
- file2: 1,000 (protected)
- file3: 32,667 (kept 32.7%)
- file4: 65,333 (kept 32.7%)
- **Total: 100,000 ✅**

Notice: Both large files kept the same percentage - fair!

---

### Example 3: Many Equal Files

**Input:**
- 300 files × 1,000 tokens each
- **Total: 300,000 tokens**
- **Target: 100,000 tokens**

**Calculation:**
```
Deficit: 200,000 tokens
Average Tax: 200,000 ÷ 300 = 666.67 per item

Below Average: NONE (all files have 1,000 > 666.67)
Above Average: ALL 300 files

Total Above: 300,000 tokens

Each file pays:
  Proportion: 1,000 ÷ 300,000 = 0.333%
  Tax: 0.333% × 200,000 = 666.67
  Final: 1,000 - 666.67 = 333.33 tokens
```

**Result:**
- 300 files × 333.33 = **100,000 ✅**

Everyone pays equally because they're all the same size - perfectly fair!

---

### Example 4: Counterexample (Requires Fallback)

**Input:**
- file1: 149 tokens
- file2: 251 tokens
- **Total: 400 tokens**
- **Target: 100 tokens**

**Calculation:**
```
Deficit: 400 - 100 = 300 tokens
Average Tax: 300 ÷ 2 = 150 per item

Below Average: file1 (149 < 150)
Above Average: file2 (251 ≥ 150)

Total Below: 149 tokens
Total Above: 251 tokens

Feasibility Check:
  Total Below (149) ≤ Target (100)? NO ❌

  149 > 100, so protection is NOT feasible!

Fallback to proportional taxation for ALL items:

file1 pays:
  Proportion: 149 ÷ 400 = 37.25%
  Tax: 37.25% × 300 = 111.75
  Final: 149 - 111.75 = 37.25 tokens

file2 pays:
  Proportion: 251 ÷ 400 = 62.75%
  Tax: 62.75% × 300 = 188.25
  Final: 251 - 188.25 = 62.75 tokens
```

**Result:**
- file1: 37.25 tokens (kept 25%)
- file2: 62.75 tokens (kept 25%)
- **Total: 100 ✅**

**Note:** Both items kept the same percentage (25%) because we fell back to proportional taxation. The protection mode would have asked file2 to pay 300 tokens (more than it has!), so fallback was necessary.

---

## Why This Works

The algorithm is mathematically guaranteed to:

1. **Always reach the target** - The deficit came from these items, so they collectively have enough to pay it
2. **Never overtax** - Items only pay their proportional share
3. **Protect small items** - Items below the average tax threshold are left untouched
4. **Be fair** - Large items pay proportionally to their contribution to the problem

## Key Properties

✅ **Handles all cases** - Works for any distribution of sizes
✅ **Mathematically sound** - Always reaches target exactly
✅ **Protection when possible** - Small items preserved if feasible
✅ **Fair fallback** - Everyone pays proportionally when protection impossible
✅ **No negative tokens** - Never asks an item to pay more than it has

## Application to Token Limits

When applied to file truncation for LLM token limits:

1. **Items** = Files + Child Graph CHEIMARROS
2. **Tokens** = Estimated token count (chars ÷ 4)
3. **Target** = 70% of max token limit (safety margin)
4. **Truncation** = Remove `tax × 4` characters from content

Each above-average item gets truncated by the exact number of characters needed to reach the target.

---

## Implementation Pseudocode

```
function progressiveTaxTruncate(items, targetTokens):
  # Step 1: Calculate deficit
  totalTokens = sum(item.tokens for item in items)
  deficit = totalTokens - targetTokens

  if deficit <= 0:
    return items  # Already under budget

  # Step 2: Average tax
  averageTax = deficit / items.length

  # Step 3: Split groups
  belowAverage = items where item.tokens < averageTax
  aboveAverage = items where item.tokens >= averageTax

  # Step 4: Check feasibility
  totalBelow = sum(item.tokens for item in belowAverage)

  if totalBelow > targetTokens:
    # Protection not feasible - everyone pays proportionally
    for each item in items:
      proportion = item.tokens / totalTokens
      tax = proportion * deficit
      item.finalTokens = item.tokens - tax
    return items

  # Step 5: Protection mode - tax only above-average
  totalAbove = sum(item.tokens for item in aboveAverage)

  for each item in aboveAverage:
    proportion = item.tokens / totalAbove
    tax = proportion * deficit
    item.finalTokens = item.tokens - tax

  # Step 6: Below-average unchanged
  for each item in belowAverage:
    item.finalTokens = item.tokens

  return items
```

---

## Comparison to Other Approaches

### ❌ Truncate all equally
```
Each item loses: deficit / itemCount tokens
Problem: Small items might go negative or lose everything
```

### ❌ Truncate largest items first
```
Remove items until under budget
Problem: Loses breadth, some content completely excluded
```

### ❌ Percentage-based truncation
```
Each item keeps: (target / total) × 100%
Problem: Small items still get truncated unnecessarily
```

### ✅ Progressive tax (this algorithm)
```
Protects small items, distributes burden fairly among large items
Result: Maximum breadth + fair distribution
```

---

## Summary

The progressive tax algorithm solves token truncation elegantly by:
- Protecting small content (below average threshold)
- Distributing cuts fairly among large content (proportional to size)
- Guaranteeing the target is reached exactly
- Working for any content distribution without edge cases

It's simple, fair, and mathematically sound.
