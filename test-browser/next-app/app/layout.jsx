// The root layout of J6's (#82) fixture app. dogear's loader writes the overlay's tag into the
// `<html>` below during `next dev`, which is the only way the overlay reaches a Next page: this
// file never mentions dogear, and neither does anything else in the app.
//
// JavaScript rather than TypeScript, so that `next dev` finds no .ts file and never tries to
// write a tsconfig.json into the scratch copy.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  )
}
