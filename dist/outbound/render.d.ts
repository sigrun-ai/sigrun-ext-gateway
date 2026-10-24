/**
 * renderChunks (spec §8.6's three-step order, verbatim):
 *
 * 1. Split the markdown final at `maxMessageLength` (paragraph, line,
 *    hard — {@link splitMarkdown}, with the fence close/reopen rule).
 * 2. Format each chunk per `capabilities.format`: `markdown` as-is,
 *    `native` through the adapter's `format`, `plain` through the
 *    engine's markdown stripper.
 * 3. A formatted chunk that STILL exceeds `maxMessageLength` (native
 *    markup grew it) is hard-split.
 *
 * Empty input renders to zero chunks (the caller owns the empty-answer
 * notice — Review Focus 4).
 */
import type { ChannelCapabilities } from "@sigrun/sigrun/extension";
/**
 * Render the markdown final into platform-ready chunks. `format` is the
 * adapter's formatter (`ChannelContribution.format`), required only for
 * `native` capabilities — a missing formatter on a native channel is
 * the loader's contract violation, handled by the caller; here the
 * chunk passes through unformatted (the honest degraded behavior for
 * an adapter that declared native markup and shipped no renderer).
 */
export declare function renderChunks(markdown: string, caps: ChannelCapabilities, format?: (md: string) => string): string[];
