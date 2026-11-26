// The root layout of J4's (#80) leak fixture: the file the loader would write dogear's client
// tag into, and stamp, if either survived into a production build.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
