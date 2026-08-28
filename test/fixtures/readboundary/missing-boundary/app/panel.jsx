import { readOverview } from "./_read/planning.jsx";
export default async function Panel() {
  const o = await readOverview();
  return <div>{o.records.length}</div>;
}
