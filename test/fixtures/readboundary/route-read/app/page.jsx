import { readOverview } from "./_read/planning.jsx";
export default async function Page() {
  const o = await readOverview();
  return <main>{o.records.length}</main>;
}
