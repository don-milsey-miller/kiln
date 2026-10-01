import { openSync, readSync, closeSync, statSync } from "node:fs";
import { extname } from "node:path";

import { INGEST_ERROR, IngestError } from "./result.mjs";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".yaml", ".yml", ".csv", ".tsv", ".html", ".htm"]);

function starts(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function ascii(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("ascii");
}

function textMetadata(sample, filename) {
  if (sample.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return null;
  }
  const ext = extname(filename).toLowerCase();
  let mediaType = "text/plain";
  let textFormat = "plain";
  if (ext === ".md" || ext === ".markdown") {
    mediaType = "text/markdown";
    textFormat = "markdown";
  } else if (ext === ".json") {
    mediaType = "application/json";
    textFormat = "json";
  } else if (ext === ".yaml" || ext === ".yml") {
    mediaType = "application/yaml";
    textFormat = "yaml";
  } else if (ext === ".csv") {
    mediaType = "text/csv";
    textFormat = "csv";
  } else if (ext === ".tsv") {
    mediaType = "text/tab-separated-values";
    textFormat = "tsv";
  } else if (ext === ".html" || ext === ".htm") {
    mediaType = "text/html";
    textFormat = "html";
  }
  return { sourceKind: "text", mediaType, textFormat };
}

export function inspectBytes(sample, { filename = "source", bytes = sample.byteLength } = {}) {
  if (!(sample instanceof Uint8Array) || bytes === 0)
    throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The source is empty or unreadable.");
  const buffer = Buffer.from(sample);

  if (ascii(buffer, 0, 5) === "%PDF-") return { sourceKind: "document", mediaType: "application/pdf", bytes };
  if (starts(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { sourceKind: "image", mediaType: "image/png", bytes };
  if (starts(buffer, [0xff, 0xd8, 0xff])) return { sourceKind: "image", mediaType: "image/jpeg", bytes };
  if (ascii(buffer, 0, 6) === "GIF87a" || ascii(buffer, 0, 6) === "GIF89a")
    return { sourceKind: "image", mediaType: "image/gif", bytes };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WEBP")
    return { sourceKind: "image", mediaType: "image/webp", bytes };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 4) === "WAVE")
    return { sourceKind: "audio", mediaType: "audio/wav", bytes };
  if (ascii(buffer, 0, 4) === "fLaC") return { sourceKind: "audio", mediaType: "audio/flac", bytes };
  if (ascii(buffer, 0, 4) === "OggS") return { sourceKind: "audio", mediaType: "audio/ogg", bytes };
  if (ascii(buffer, 0, 3) === "ID3" || starts(buffer, [0xff, 0xfb]) || starts(buffer, [0xff, 0xf3]))
    return { sourceKind: "audio", mediaType: "audio/mpeg", bytes };
  if (ascii(buffer, 4, 4) === "ftyp") return { sourceKind: "audio", mediaType: "audio/mp4", bytes };

  const text = textMetadata(buffer, filename);
  if (text) return { ...text, bytes };
  const extension = extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension))
    throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The file extension suggests text, but the bytes are not valid UTF-8 text.");
  return { sourceKind: "unknown", mediaType: "application/octet-stream", bytes };
}

export function inspectFile(path, opts = {}) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new IngestError(INGEST_ERROR.INVALID_SOURCE, "The retained source is not a regular file.");
  const length = Math.min(stat.size, opts.sampleBytes ?? 64 * 1024);
  const sample = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, sample, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  return inspectBytes(sample, { filename: opts.filename, bytes: stat.size });
}
