/** Map a delivered interaction ledger row back to its recipient key. */
import type { LedgerEntry } from "../state/ledger.js";
import type { PromptStore } from "./prompts.js";
export declare function receiptForInteraction(prompts: PromptStore, entry: LedgerEntry, receipt: {
    readonly messageIds: readonly string[];
}): Promise<void>;
