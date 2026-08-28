import { readFileSync } from "node:fs";
export default function Panel() {
  return <div>{readFileSync("x", "utf-8")}</div>;
}
