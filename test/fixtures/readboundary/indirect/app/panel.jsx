import { lintProject } from "./_helpers/data.jsx";
export default async function Panel() {
  return <div>{lintProject().records.length}</div>;
}
