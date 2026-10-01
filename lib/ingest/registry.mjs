import { INGEST_ERROR, IngestError } from "./result.mjs";

export function createProcessorRegistry(processors = []) {
  const entries = [...processors];
  for (const processor of entries) {
    if (!processor || typeof processor.id !== "string" || !processor.id || typeof processor.accepts !== "function" ||
        typeof processor.probe !== "function" || typeof processor.process !== "function")
      throw new TypeError("Each ingestion processor must expose id, accepts(), probe(), and process().");
  }
  if (new Set(entries.map((processor) => processor.id)).size !== entries.length)
    throw new TypeError("Ingestion processor ids must be unique.");

  return Object.freeze({
    processors: Object.freeze(entries),
    async select(metadata, context = {}) {
      const accepted = entries.filter((processor) => processor.accepts(metadata));
      if (accepted.length === 0)
        throw new IngestError(INGEST_ERROR.UNSUPPORTED_TYPE, `No ingestion processor accepts ${metadata.mediaType}.`);

      const probes = [];
      for (const processor of accepted) {
        let probe;
        try {
          probe = await processor.probe(context);
        } catch {
          probe = { available: false, reason: "probe-failed" };
        }
        probes.push({ processor: processor.id, ...probe });
        if (probe?.available === true) return { processor, probe, probes };
      }
      throw new IngestError(INGEST_ERROR.PROCESSOR_UNAVAILABLE, "No configured processor is currently available.", {
        probes,
      });
    },
  });
}
