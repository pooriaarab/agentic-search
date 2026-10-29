import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "agentic-design/styles.css";
import "../src/ui/search.css";
import "./demo.css";
import { createClient } from "../src/client.js";
import { SearchBox, type SearchHit } from "../src/ui/index.js";

// The demo Worker has no sign-in and holds sample items only. Any token works.
const client = createClient({ baseUrl: window.location.origin, token: "demo" });

function Demo() {
  const [picked, setPicked] = useState<SearchHit | null>(null);
  return (
    <main className="demo">
      <h1>agentic-search</h1>
      <p className="demo__lead">Search sample documents, sheets, slides, files and comments. Press / or Ctrl+K to start.</p>
      <SearchBox client={client} onSelect={setPicked} />
      <p className="demo__picked" role="status">
        {picked === null ? "Pick a result with the arrow keys and Enter." : `You picked ${picked.title}, a ${picked.kind}.`}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
