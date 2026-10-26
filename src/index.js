// Public entry point for the W3 provenance seal library.
// See README.md for usage and SPEC.md (one level up) for the design.

export {
  C14N_ID,
  canonicalizeText,
  canonicalBytes,
  canonicalBytesFromBuffer,
  contentHash,
  splitFrontMatter,
  frontMatterField,
} from "./canonicalize.js";

export {
  SEAL_VERSION,
  SIGN_DOMAIN,
  ApprovedTierDisabled,
  createSeal,
  sealCore,
  payloadHash,
  signedText,
  withAnchor,
  withSupersededBy,
} from "./seal.js";

export {
  VERIFY_RESULT_SCHEMA,
  FAILURE_STATES,
  humanIdHash,
  verifySeal,
  verifyByHash,
  MemorySealIndex,
} from "./verify.js";

export { w0AgentBookProvider } from "./agentbook-w0.js";

export {
  WORLD_CHAIN_ID,
  anchorCalldata,
  AnchorNotConfigured,
  MockLocalChain,
  WorldChainAnchorProvider,
} from "./anchor.js";

export {
  PrivateKeySigner,
  privateKeyToAddress,
  recoverMessageAddress,
  toChecksumAddress,
} from "./wallet.js";
