import { VOICE_DEFAULTS, VOICE_LIMITS } from "./config.mjs";

export const SPEECH_TEXT_MARKERS = Object.freeze({
  code: "Code block omitted.",
  table: "Table omitted.",
  structured: "Structured data omitted.",
  url: "link omitted",
  path: "file path omitted",
});

const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
const RAW_URL = /\b(?:https?|ftp):\/\/[^\s<>]+/giu;
const WINDOWS_PATH = /(?:\b[A-Za-z]:\\|\\\\)[^\s<>|"']+/gu;
const UNIX_PATH = /(?:^|[\s(])\/(?:[^\s<>|"')]+\/)*[^\s<>|"')]+/gu;
const ARTIFACT_ID = /\b([A-Z]{2,8})-(\d{3,8})\b/g;

function textContent(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function withoutFencedCode(source) {
  const lines = source.split(/\r?\n/);
  const output = [];
  let fence = null;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence === null && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = trimmed[0];
      output.push(SPEECH_TEXT_MARKERS.code);
      continue;
    }
    if (fence !== null) {
      if (trimmed.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function withoutTables(source) {
  const lines = source.split(/\r?\n/);
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    const currentCells = tableCells(current);
    const separatorCells = next === undefined ? [] : tableCells(next);
    const isHeader = current.includes("|")
      && separatorCells.length >= 2
      && separatorCells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
    if (!isHeader) {
      output.push(current);
      continue;
    }
    output.push(SPEECH_TEXT_MARKERS.table);
    index += 1;
    while (index + 1 < lines.length && lines[index + 1].includes("|")) index += 1;
  }
  return output.join("\n");
}

function withoutStructuredParagraphs(source) {
  return source
    .split(/\n\s*\n/)
    .map((paragraph) => {
      const candidate = paragraph.trim();
      if (!candidate || !((candidate.startsWith("{") && candidate.endsWith("}"))
        || (candidate.startsWith("[") && candidate.endsWith("]")))) return paragraph;
      try {
        JSON.parse(candidate);
        return SPEECH_TEXT_MARKERS.structured;
      } catch {
        return paragraph;
      }
    })
    .join("\n\n");
}

function markdownToProse(source) {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(RAW_URL, SPEECH_TEXT_MARKERS.url)
    .replace(WINDOWS_PATH, SPEECH_TEXT_MARKERS.path)
    .replace(UNIX_PATH, (match, offset, whole) => {
      const prefix = whole[offset] === "/" ? "" : whole[offset];
      return `${prefix}${SPEECH_TEXT_MARKERS.path}`;
    })
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~]+/g, "")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&(?:amp|#38);/gi, " and ")
    .replace(/&(?:lt|#60);/gi, " less than ")
    .replace(/&(?:gt|#62);/gi, " greater than ")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(ARTIFACT_ID, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text, maxCharacters) {
  if (text.length <= maxCharacters) return text;
  const available = maxCharacters - 1;
  const prefix = text.slice(0, available);
  const boundary = prefix.lastIndexOf(" ");
  const body = (boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd();
  return `${body}\u2026`;
}

/**
 * Convert one finalized Pi assistant message into bounded, deterministic spoken prose.
 * The input is never mutated and no provider or model is consulted.
 */
export function speechText(message, { maxCharacters = VOICE_DEFAULTS.maxTtsCharacters } = {}) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2 || maxCharacters > VOICE_LIMITS.maxTtsCharacters) {
    throw new RangeError(`maxCharacters must be an integer from 2 to ${VOICE_LIMITS.maxTtsCharacters}`);
  }
  const prose = markdownToProse(withoutStructuredParagraphs(withoutTables(withoutFencedCode(textContent(message)))));
  return prose ? bounded(prose, maxCharacters) : "";
}
