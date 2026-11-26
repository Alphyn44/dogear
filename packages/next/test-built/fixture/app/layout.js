// The root layout of the J3 (#79) fixture app. JavaScript rather than TypeScript, so that
// `next dev` finds no .ts file and never tries to write a tsconfig.json into the scratch copy.
//
// `.js` rather than `.jsx` since J4 (#80), because `create-next-app --js` writes JSX into a
// `.js` root layout and dogear's client tag has to reach it. The fixture's config adds `.js` to
// `include`, so J2's stamp assertions still cover this file too.
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
