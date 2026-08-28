import { Suspense } from "react";
import Panel from "./panel.jsx";
export default function Page() {
  return <main><Suspense fallback={<p>loading</p>}><Panel /></Suspense></main>;
}
