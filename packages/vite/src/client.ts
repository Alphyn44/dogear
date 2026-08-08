import { SENTINEL } from './sentinel.js'

/**
 * M0's payload — deliberately crude, and deliberately temporary.
 *
 * A1's story is the injection *path*: proving that adding the plugin puts a script on the
 * page without the user's source referencing dogear, and that the same script is absent
 * from a production build. What the script does is beside the point until B1–B7, which
 * replace this body with a `src` pointing at @dogear/core and the real overlay.
 *
 * The brief offers `alert('loaded')` as sufficient. A log line is used instead: A1 lands
 * several tickets before B1, and an alert firing on every page load and every HMR full
 * reload would make examples/react-app tedious to work in for the rest of M0. The
 * `window.__dogear` marker gives the same "did it run?" answer from the console, and gives
 * a browser-side check something to assert against later.
 *
 * The sentinel is carried BOTH here and on the injected tag's `data-dogear` attribute. It
 * is impossible to predict which of the two a hypothetical leak would preserve, and
 * check:leak is a plain substring scan — a second carrier costs nothing.
 *
 * Emitted as inline `<script>` content, so this text must never contain the sequence
 * `</script>`: the HTML parser would end the element early, whatever the JavaScript meant.
 */
export const CLIENT_SOURCE = `
console.info('[dogear] dev script loaded')
window.__dogear = { sentinel: ${JSON.stringify(SENTINEL)} }
`
