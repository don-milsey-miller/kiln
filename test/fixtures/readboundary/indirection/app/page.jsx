import { Suspense } from "react";
import Panel from "./panel.jsx";

// The component is handed to a wrapper as a value. A <Suspense> exists, but nothing here says the
// component ends up inside it \u2014 the analysis refuses rather than assuming.
function Wrapper({ comp: C }) {
  return <Suspense fallback={<p>l</p>}><C /></Suspense>;
}
export default function Page() {
  return <main><Wrapper comp={Panel} /></main>;
}
