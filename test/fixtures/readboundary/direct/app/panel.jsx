import { lintProject } from "./server/content.jsx";
export default async function Panel() {
  return <div>{lintProject().records.length}</div>;
}
