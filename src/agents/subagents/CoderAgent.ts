/**
 * Durable Object export for the **Coder** sub-agent facet.
 *
 * Runtime shape is {@link CoderAgentThinkFacet} (Think + delegation tools + shared workspace tools).
 */
import { CoderAgentThinkFacet } from "./CoderAgentThinkFacet";

export class CoderAgent extends CoderAgentThinkFacet {}

export { CoderAgentThinkFacet } from "./CoderAgentThinkFacet";
