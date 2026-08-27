export const metadata = {
  title: "visual-project-workflow",
  description: "Local-first planning system",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ font: "15px/1.5 system-ui, sans-serif", color: "#111", margin: 0 }}>{children}</body>
    </html>
  );
}
