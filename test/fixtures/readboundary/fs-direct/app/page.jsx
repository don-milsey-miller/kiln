import { Suspense } from "react";
import Panel from "./panel.jsx";
export default function Page() {
  return <main><Suspense fallback={<p>l</p>}><Panel /></Suspense></main>;
}
