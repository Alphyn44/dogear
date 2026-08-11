import { dogear } from '@dogear/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `@dogear/vite` resolves through its package.json `exports` to the BUILT dist, not to
// packages/vite/src. That is deliberate: a source alias would be nicer to iterate on,
// but it would bypass the exports map and the build output — which are precisely what
// F1 (layer 3) and F2 (the leak check) exist to police. An example that skips them is
// not evidence of anything.
//
// So: rebuild the plugin before this app sees a change to it.
//   npm run build -w @dogear/vite
export default defineConfig({
  plugins: [dogear(), react()],
})
