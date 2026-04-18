# Upstream Bugs in Radiant-Core/RadiantScript

While building rxdc from source to compile the contracts in this repo, three real bugs were found that currently block fresh builds from master. All are simple to fix and should be filed as separate issues/PRs on [Radiant-Core/RadiantScript](https://github.com/Radiant-Core/RadiantScript).

## Bug 1: Duplicate property keys in `packages/cashc/src/generation/utils.ts`

**Severity**: Blocks TypeScript compilation (build failure)

**Location**: `packages/cashc/src/generation/utils.ts` lines 53-57

**Description**: The `compileGlobalFunction` mapping includes three `CODESCRIPTHASH…_OUTPUTS` entries in lines 53-57 that are duplicated at lines 69-78 (where the complete `_UTXOS`/`_OUTPUTS` pair block lives). TypeScript rejects with:

```
error TS1117: An object literal cannot have multiple properties with the same name.
```

**Fix**: Delete the partial duplicates at lines 53-57. The complete block at lines 69-78 remains.

```diff
     [GlobalFunction.SHA512_256]: [RadiantOp.OP_SHA512_256],
     [GlobalFunction.HASH512_256]: [RadiantOp.OP_HASH512_256],
-    [GlobalFunction.CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS]:
-      [RadiantOp.OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS],
-    [GlobalFunction.CODESCRIPTHASHVALUESUM_OUTPUTS]: [RadiantOp.OP_CODESCRIPTHASHVALUESUM_OUTPUTS],
-    [GlobalFunction.CODESCRIPTHASHZEROVALUEDOUTPUTCOUNT_OUTPUTS]:
-      [RadiantOp.OP_CODESCRIPTHASHZEROVALUEDOUTPUTCOUNT_OUTPUTS],
     [GlobalFunction.REFHASHVALUESUM_UTXOS]: [RadiantOp.OP_REFHASHVALUESUM_UTXOS],
```

## Bug 2: `@cashscript/utils` import leftover (should be `@radiantscript/utils`)

**Severity**: Blocks TypeScript compilation (module not found)

**Locations**:
- `packages/cashc/src/ast/Globals.ts` line 1
- `packages/cashc/src/generation/utils.ts` line 10

**Description**: Two files still import from the legacy namespace `@cashscript/utils`, which no longer exists in the workspace — the package was renamed to `@radiantscript/utils`. Compilation fails with:

```
error TS2307: Cannot find module '@cashscript/utils' or its corresponding type declarations.
```

**Fix**:

```diff
--- a/packages/cashc/src/ast/Globals.ts
+++ b/packages/cashc/src/ast/Globals.ts
@@ -1,1 +1,1 @@
-import { PrimitiveType, ArrayType, BytesType } from '@cashscript/utils';
+import { PrimitiveType, ArrayType, BytesType } from '@radiantscript/utils';
```

```diff
--- a/packages/cashc/src/generation/utils.ts
+++ b/packages/cashc/src/generation/utils.ts
@@ -10,1 +10,1 @@
-} from '@cashscript/utils';
+} from '@radiantscript/utils';
```

## Bug 3: `OP_BLAKE3` and `OP_K12` referenced but undefined

**Severity**: Blocks TypeScript compilation (property does not exist)

**Location**: `packages/cashc/src/generation/utils.ts` lines 49-50

**Description**: The `compileGlobalFunction` mapping references `Op.OP_BLAKE3` and `Op.OP_K12`, but neither is defined on `OpcodesBCH` (base BCH opcode enum) nor on `RadiantOp` (Radiant extensions enum in `packages/utils/src/script.ts`). Compilation fails with:

```
error TS2339: Property 'OP_BLAKE3' does not exist on type 'typeof OpcodesBCH'.
error TS2551: Property 'OP_K12' does not exist on type 'typeof OpcodesBCH'. Did you mean 'OP_12'?
```

The `examples/v2_test.rad` contract uses `blake3(x)` as if it were a standard primitive, suggesting BLAKE3 was *intended* to be supported but the opcode integration was never completed.

**Fix options**:

**Option A** (if BLAKE3 and K12 are planned and opcodes will be assigned):
Add them to `RadiantOp` enum in `packages/utils/src/script.ts` and reference `RadiantOp.OP_BLAKE3` / `RadiantOp.OP_K12` in utils.ts:

```typescript
// packages/utils/src/script.ts
export enum RadiantOp {
  // ... existing opcodes ...
  OP_BLAKE3 = 0xXX,  // TBD opcode number
  OP_K12   = 0xXX,   // TBD opcode number
}
```

**Option B** (if BLAKE3/K12 are not yet planned):
Remove `BLAKE3` and `K12` from the `GlobalFunction` enum in `packages/cashc/src/ast/Globals.ts` and from any language-level keyword definitions, then remove the corresponding entries from utils.ts. The `v2_test.rad` example should be updated or removed.

As a temporary workaround for local builds, stub them to empty arrays:

```typescript
[GlobalFunction.BLAKE3]: [] as any,  // TODO: OP_BLAKE3 not yet defined
[GlobalFunction.K12]: [] as any,     // TODO: OP_K12 not yet defined
```

This allows the compiler to build, but any contract that uses `blake3()` or `k12()` will silently compile to empty bytecode. Not a production-safe workaround.

## Filing

These should be three separate issues on `Radiant-Core/RadiantScript`. PRs for Bugs 1 and 2 are trivial. Bug 3 needs a design decision from the maintainers about intent (Options A vs B).
