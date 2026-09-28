import { readProjectIdentity } from "./_read/planning.js";

/**
 * The active project's visible identity.
 *
 * The manifest is project-authored, so React renders it only as escaped text. A missing or
 * unsupported identity gets a neutral label and an explicit diagnostic; it never falls back to
 * the tool repository's own project name.
 */
export default async function ProjectIdentity({ compact = false }) {
  const identity = await readProjectIdentity();
  const readable = typeof identity.name === "string" && identity.name.length > 0;
  const name = readable ? identity.name : "Kiln project";

  if (compact)
    return (
      <span data-vpw-project-name={name} data-vpw-project-identity={readable ? "readable" : "unreadable"}>
        {name}
      </span>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <div
        data-vpw-project-name={name}
        data-vpw-project-identity={readable ? "readable" : "unreadable"}
        style={{ fontSize: "1.15rem", fontWeight: 600 }}
      >
        {name}
      </div>
      {readable && identity.description ? (
        <div style={{ color: "#666", fontSize: ".85rem" }}>{identity.description}</div>
      ) : !readable ? (
        <div role="alert" style={{ color: "#a01f1f", fontSize: ".85rem" }}>
          Project identity could not be read from project.yaml.
        </div>
      ) : null}
    </div>
  );
}
