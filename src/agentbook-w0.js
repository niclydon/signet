// Adapter from the W0 verify core (@fiador/verify, packages/verify-ts
// in the Fiador repo) to the AgentBook provider interface that
// verifySeal consumes. This is the one sanctioned crossing between
// W3 and W0: W3 depends on W0's public result shape only, never on
// its internals, and never on the raw humanId.
//
// W0's verifyAddress returns a result whose status is one of
// verified / unregistered / invalid / expired / unknown, with
// humanHash set (bare hex, the program-canonical construction of
// W0 SPEC 3.5) only when verified. The mapping to W3's provider
// contract:
//   verified     -> { humanHash }   (verifySeal passes the check and
//                                    records human_id_hash from it)
//   unregistered -> null            (verifySeal: wallet-not-registered)
//   anything else (unknown, invalid, expired; an address-only check
//   has no attestation, so invalid/expired should not occur)
//                -> throw           (verifySeal: check-incomplete,
//                                    never a fabricated verdict)
//
// The verifier is injected: the caller builds it with W0's
// createVerifier (direct viem contract read by default) and passes
// it in, so this module imports nothing from the Fiador repo and
// the W3 library stays dependency-light and offline-testable.

export function w0AgentBookProvider(verifier) {
  if (!verifier || typeof verifier.verifyAddress !== "function") {
    throw new TypeError(
      "w0AgentBookProvider needs a W0 verifier (an object with verifyAddress, e.g. from @fiador/verify createVerifier)",
    );
  }
  return {
    source: "w0-verify-core",
    async lookupHuman(address) {
      const result = await verifier.verifyAddress(address);
      if (result.status === "verified") {
        if (!result.humanHash) {
          throw new Error("W0 verifier reported verified without a humanHash");
        }
        return { humanHash: result.humanHash };
      }
      if (result.status === "unregistered") return null;
      const codes = Array.isArray(result.failures) && result.failures.length
        ? ` (${result.failures.join(", ")})`
        : "";
      throw new Error(`W0 verifyAddress returned ${result.status}${codes}`);
    },
  };
}
