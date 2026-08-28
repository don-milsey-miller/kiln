import StreamWatchdog from "./_stream/watchdog.js";

export const metadata = {
  title: "visual-project-workflow",
  description: "Local-first planning system",
};

/**
 * ⚠️ The stream indicator lives in the LAYOUT so it is on every page. Its state is the only thing
 * standing between the operator and a page that looks fine while nothing can refresh it — AST-0034
 * measured an idle stream and a dead one as byte-identical — so it must not be something a
 * particular view can forget to include.
 */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ font: "15px/1.5 system-ui, sans-serif", color: "#111", margin: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            maxWidth: "60rem",
            margin: "0 auto",
            padding: "10px 1.5rem 0",
          }}
        >
          <StreamWatchdog />
        </div>
        {children}
      </body>
    </html>
  );
}
