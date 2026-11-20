// The root layout of the J3 (#79) fixture app. JavaScript rather than TypeScript, so that
// `next dev` finds no .ts file and never tries to write a tsconfig.json into the scratch copy.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
