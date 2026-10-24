/**
 * The core session-meta document token, re-declared structurally from
 * the shared wire type. Standalone doc tokens compare by kind/scope;
 * declaring it here avoids a runtime import of core's server modules.
 */
import type { SessionMeta } from "@sigrun/shared/views";
export declare const SessionMetaDoc: import("@earendil-works/pi-durable").ConversationDocToken<SessionMeta>;
